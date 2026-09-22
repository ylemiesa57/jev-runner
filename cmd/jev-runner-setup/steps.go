package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	jevrunner "jevrunner"
)

const (
	nodeMinMajor = 20 // @typesafe-ai/sdk requires Node 20+
	typesafeURL  = "https://api.typesafe.ai/v1/systemone"
)

// ---- Node.js ---------------------------------------------------------------------------------

func nodeMajor(node string) int {
	out, err := output(10*time.Second, nil, "", node, "--version")
	if err != nil {
		return 0
	}
	v := strings.TrimPrefix(strings.TrimSpace(out), "v")
	n, _ := strconv.Atoi(strings.SplitN(v, ".", 2)[0])
	return n
}

// ensureNode returns a bin directory holding node and npm, downloading the current LTS if needed.
func ensureNode(yes bool) (string, error) {
	local := filepath.Join(home(), ".local", "node", "bin")
	for _, dir := range []string{"", local, "/opt/homebrew/bin", "/usr/local/bin"} {
		node := "node"
		if dir != "" {
			node = filepath.Join(dir, "node")
			if !exists(node) {
				continue
			}
		}
		if p := lookPath([]string{node}); p != "" {
			if m := nodeMajor(p); m >= nodeMinMajor {
				ok("node v%d at %s", m, filepath.Dir(p))
				return filepath.Dir(p), nil
			} else if m > 0 {
				warn("node v%d at %s is too old (need %d+)", m, filepath.Dir(p), nodeMinMajor)
			}
		}
	}
	if !confirm(fmt.Sprintf("Node.js %d+ not found. Download the current LTS into ~/.local/node?", nodeMinMajor), true, yes) {
		return "", errors.New("Node.js 20+ is required")
	}
	return installNode()
}

func installNode() (string, error) {
	resp, err := http.Get("https://nodejs.org/dist/index.json")
	if err != nil {
		return "", fmt.Errorf("nodejs.org: %w", err)
	}
	defer resp.Body.Close()
	var releases []struct {
		Version string `json:"version"`
		LTS     any    `json:"lts"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return "", fmt.Errorf("nodejs.org index: %w", err)
	}
	var v string
	for _, r := range releases {
		if s, isName := r.LTS.(string); isName && s != "" {
			v = r.Version
			break
		}
	}
	if v == "" {
		return "", errors.New("no LTS release found in nodejs.org index")
	}
	arch := map[string]string{"arm64": "arm64", "amd64": "x64"}[runtime.GOARCH]
	url := fmt.Sprintf("https://nodejs.org/dist/%s/node-%s-darwin-%s.tar.gz", v, v, arch)
	info("downloading %s", url)
	dest := filepath.Join(home(), ".local", "node")
	if err := downloadUntar(url, dest, 1); err != nil {
		return "", err
	}
	bin := filepath.Join(dest, "bin")
	ok("node %s installed at %s", v, bin)
	return bin, nil
}

// downloadUntar streams a .tar.gz into dest, stripping `strip` leading path components.
func downloadUntar(url, dest string, strip int) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	if err := os.RemoveAll(dest); err != nil {
		return err
	}
	gz, err := gzip.NewReader(resp.Body)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		parts := strings.Split(strings.TrimPrefix(h.Name, "./"), "/")
		if len(parts) <= strip {
			continue
		}
		rel := filepath.Join(parts[strip:]...)
		if strings.HasPrefix(rel, "..") {
			continue
		}
		p := filepath.Join(dest, rel)
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(p, 0o755); err != nil {
				return err
			}
		case tar.TypeSymlink:
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			_ = os.Remove(p)
			if err := os.Symlink(h.Linkname, p); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fs.FileMode(h.Mode)&0o777)
			if err != nil {
				return err
			}
			_, err = io.Copy(f, tr)
			f.Close()
			if err != nil {
				return err
			}
		}
	}
}

// ---- App -------------------------------------------------------------------------------------

// installApp unpacks the embedded app over appDir (leaving node_modules and .env alone) and runs npm install.
func installApp(appDir, nodeBin string) error {
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		return err
	}
	n := 0
	err := fs.WalkDir(jevrunner.App, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		target := filepath.Join(appDir, filepath.FromSlash(path))
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := jevrunner.App.ReadFile(path)
		if err != nil {
			return err
		}
		mode := fs.FileMode(0o644)
		if strings.HasPrefix(path, "scripts/") {
			mode = 0o755
		}
		n++
		return os.WriteFile(target, b, mode)
	})
	if err != nil {
		return fmt.Errorf("unpack: %w", err)
	}
	ok("%d app files written to %s", n, appDir)

	npm := filepath.Join(nodeBin, "npm")
	info("npm install (Electron is ~100 MB on first install)…")
	if err := runCmd(appDir, withPath(nodeBin), npm, "install", "--no-audit", "--no-fund", "--loglevel=error"); err != nil {
		return err
	}
	if !exists(filepath.Join(appDir, "node_modules", ".bin", "electron")) {
		return errors.New("npm install finished but node_modules/.bin/electron is missing")
	}
	ok("dependencies installed")
	return nil
}

// ---- TypeSafe --------------------------------------------------------------------------------

// validateKey makes the cheapest possible real call; 401/403 means the key is wrong.
func validateKey(key string) (bool, string) {
	body := `{"model":"jev-latest","state":"ping","questions":{"ok":{"type":"noul","instructions":"Is the state exactly the word ping?"}}}`
	req, _ := http.NewRequest("POST", typesafeURL, bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return false, "network: " + err.Error()
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	switch {
	case resp.StatusCode == 200:
		var r struct {
			Model string `json:"model"`
			Usage struct {
				In int `json:"input_tokens"`
			} `json:"usage"`
		}
		_ = json.Unmarshal(b, &r)
		return true, fmt.Sprintf("model %s answered", r.Model)
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		return false, "rejected (" + resp.Status + ")"
	default:
		return true, "unexpected " + resp.Status + " — accepting the key anyway"
	}
}

func setupTypeSafe(appDir, flagKey string, yes bool) error {
	envPath := filepath.Join(appDir, ".env")
	existing := readEnvFile(envPath)
	key, source := flagKey, "--typesafe-key"
	if key == "" {
		key, source = os.Getenv("TYPESAFE_API_KEY"), "$TYPESAFE_API_KEY"
	}
	if key == "" {
		key, source = existing["TYPESAFE_API_KEY"], ".env"
	}
	for attempt := 0; ; attempt++ {
		if key == "" {
			if yes {
				return errors.New("no TypeSafe key: pass --typesafe-key or set TYPESAFE_API_KEY (get one at https://console.typesafe.ai)")
			}
			if attempt > 0 {
				return errors.New("no TypeSafe key given")
			}
			key, source = readSecret("TypeSafe API key (console.typesafe.ai → API keys): "), "prompt"
			continue
		}
		valid, detail := validateKey(key)
		if valid {
			ok("key from %s works — %s", source, detail)
			break
		}
		warn("key from %s %s", source, detail)
		if yes {
			return errors.New("TypeSafe key rejected")
		}
		key, source = "", ""
	}
	existing["TYPESAFE_API_KEY"] = key
	var sb strings.Builder
	for k, v := range existing {
		fmt.Fprintf(&sb, "%s=%s\n", k, v)
	}
	if err := os.WriteFile(envPath, []byte(sb.String()), 0o600); err != nil {
		return err
	}
	ok("written to %s (mode 600)", envPath)
	return nil
}

// ---- browser-harness -------------------------------------------------------------------------

func findHarness() string {
	return lookPath([]string{"browser-harness"}, filepath.Join(home(), ".local", "bin"))
}

func setupHarness(yes bool) (string, error) {
	localBin := filepath.Join(home(), ".local", "bin")
	bh := findHarness()
	if bh == "" {
		uv := lookPath([]string{"uv"}, localBin)
		if uv == "" {
			if !confirm("browser-harness needs uv. Install uv with the official script (astral.sh)?", true, yes) {
				return "", errors.New("browser-harness not installed (needs uv: https://docs.astral.sh/uv/)")
			}
			if err := runCmd("", nil, "/bin/sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"); err != nil {
				return "", err
			}
			if uv = lookPath([]string{"uv"}, localBin); uv == "" {
				return "", errors.New("uv installed but not found in ~/.local/bin")
			}
		}
		info("uv tool install browser-harness…")
		if err := runCmd("", withPath(localBin), uv, "tool", "install", "--python", "3.12", "--upgrade", "browser-harness"); err != nil {
			return "", err
		}
		if bh = findHarness(); bh == "" {
			return "", errors.New("browser-harness installed but not found in ~/.local/bin")
		}
	}
	ver, _ := output(20*time.Second, nil, "", bh, "--version")
	ok("browser-harness %s at %s", strings.TrimSpace(ver), bh)
	return bh, checkChrome(bh, yes)
}

// checkChrome makes one real call through the harness; that is the only honest test of the
// chrome://inspect remote-debugging switch.
func checkChrome(bh string, yes bool) error {
	info("connecting to Chrome…")
	env := append(withPath(filepath.Dir(bh)), "BH_TAB_MARKER=0")
	out, err := output(30*time.Second, env, "print('@@TABS@@', len(list_tabs()))\n", bh)
	if err == nil {
		if i := strings.Index(out, "@@TABS@@"); i >= 0 {
			ok("Chrome connected: %s tabs", strings.TrimSpace(strings.TrimPrefix(out[i:], "@@TABS@@")))
			return nil
		}
	}
	warn("could not reach Chrome through the harness (%v)", err)
	fmt.Println("    Chrome needs its remote-debugging switch on once:")
	fmt.Println("      1. In Chrome open  chrome://inspect/#remote-debugging")
	fmt.Println("      2. Tick the checkbox; if Chrome shows an “Allow remote debugging?” sheet, approve it")
	fmt.Println("         (or run:  browser-harness mac-approve)")
	fmt.Println("      3. Rerun:  jev-runner-setup doctor")
	if confirm("Open that Chrome page now?", true, yes) {
		_ = runCmd("", nil, "open", "-a", "Google Chrome", "chrome://inspect/#remote-debugging")
	}
	return errors.New("Chrome not reachable yet")
}

// ---- Launcher --------------------------------------------------------------------------------

func installLauncher(appDir, nodeBin string) (string, error) {
	dir := filepath.Join(home(), ".local", "bin")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "jev-runner")
	script := fmt.Sprintf(`#!/bin/sh
# Launch Jev Runner. Written by jev-runner-setup; safe to edit.
export PATH=%q:"$HOME/.local/bin:$PATH"
cd %q || exit 1
exec ./node_modules/.bin/electron . "$@"
`, nodeBin, appDir)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		return "", err
	}
	ok("launcher at %s", path)
	if !strings.Contains(":"+os.Getenv("PATH")+":", ":"+dir+":") {
		warn("%s is not on your PATH; add  export PATH=\"$HOME/.local/bin:$PATH\"  to your shell profile", dir)
	}
	return path, nil
}
