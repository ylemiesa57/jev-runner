package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// doctor reports on every component without changing anything.
func doctor(args []string) int {
	o, _ := parse(args)
	problems := 0
	bad := func(f string, a ...any) { fail(f, a...); problems++ }

	step("Node.js")
	nodeBin := ""
	for _, dir := range []string{"", filepath.Join(home(), ".local", "node", "bin"), "/opt/homebrew/bin", "/usr/local/bin"} {
		node := "node"
		if dir != "" {
			node = filepath.Join(dir, "node")
		}
		if p := lookPath([]string{node}); p != "" && nodeMajor(p) >= nodeMinMajor {
			nodeBin = filepath.Dir(p)
			ok("node v%d at %s", nodeMajor(p), nodeBin)
			break
		}
	}
	if nodeBin == "" {
		bad("no Node.js %d+ found", nodeMinMajor)
	}

	step("App")
	switch {
	case !exists(filepath.Join(o.appDir, "package.json")):
		bad("not installed at %s", o.appDir)
	case !exists(filepath.Join(o.appDir, "node_modules", ".bin", "electron")):
		bad("%s has no node_modules; run `jev-runner-setup install`", o.appDir)
	default:
		ok("installed at %s", o.appDir)
	}

	step("TypeSafe")
	if key := readEnvFile(filepath.Join(o.appDir, ".env"))["TYPESAFE_API_KEY"]; key == "" {
		bad("no TYPESAFE_API_KEY in %s", filepath.Join(o.appDir, ".env"))
	} else if valid, detail := validateKey(key); valid {
		ok("key works — %s", detail)
	} else {
		bad("key %s", detail)
	}

	step("browser-harness")
	if bh := findHarness(); bh == "" {
		bad("not installed (page actions unavailable)")
	} else {
		ver, _ := output(20*time.Second, nil, "", bh, "--version")
		ok("%s at %s", strings.TrimSpace(ver), bh)
		if err := checkChrome(bh, true); err != nil {
			problems++
		}
	}

	step("Launcher")
	launcher := filepath.Join(home(), ".local", "bin", "jev-runner")
	if !exists(launcher) {
		bad("missing %s", launcher)
	} else {
		ok("%s", launcher)
		if !strings.Contains(":"+os.Getenv("PATH")+":", ":"+filepath.Dir(launcher)+":") {
			warn("~/.local/bin is not on PATH")
		}
	}

	step("Accessibility")
	if out, err := output(5*time.Second, nil, "", "osascript", "-e", `tell application "System Events" to get name of first application process whose frontmost is true`); err == nil {
		ok("System Events readable (frontmost: %s)", strings.TrimSpace(out))
	} else {
		warn("System Events not readable from this terminal — native click / type need Accessibility for the launching app")
	}

	fmt.Println()
	if problems == 0 {
		ok("everything looks good")
		return 0
	}
	fail("%d problem(s)", problems)
	return 1
}
