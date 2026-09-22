package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

var stdin = bufio.NewReader(os.Stdin)

func step(title string)       { fmt.Printf("\n%s\n", title) }
func ok(f string, a ...any)   { fmt.Printf("  ✓ "+f+"\n", a...) }
func warn(f string, a ...any) { fmt.Printf("  ! "+f+"\n", a...) }
func fail(f string, a ...any) { fmt.Fprintf(os.Stderr, "  ✗ "+f+"\n", a...) }
func info(f string, a ...any) { fmt.Printf("    "+f+"\n", a...) }

func home() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return os.Getenv("HOME")
	}
	return h
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// confirm asks a yes/no question; --yes returns the default without asking.
func confirm(q string, def, yes bool) bool {
	if yes {
		return def
	}
	hint := "Y/n"
	if !def {
		hint = "y/N"
	}
	fmt.Printf("  %s [%s] ", q, hint)
	line, _ := stdin.ReadString('\n')
	line = strings.ToLower(strings.TrimSpace(line))
	if line == "" {
		return def
	}
	return line == "y" || line == "yes"
}

// readSecret reads a line without echo (via stty on the controlling terminal).
func readSecret(prompt string) string {
	fmt.Print("  " + prompt)
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		line, _ := stdin.ReadString('\n')
		return strings.TrimSpace(line)
	}
	defer tty.Close()
	off := exec.Command("stty", "-echo")
	off.Stdin = tty
	_ = off.Run()
	line, _ := bufio.NewReader(tty).ReadString('\n')
	on := exec.Command("stty", "echo")
	on.Stdin = tty
	_ = on.Run()
	fmt.Println()
	return strings.TrimSpace(line)
}

// lookPath finds the first of names on PATH or in extraDirs.
func lookPath(names []string, extraDirs ...string) string {
	for _, n := range names {
		if p, err := exec.LookPath(n); err == nil {
			return p
		}
		for _, d := range extraDirs {
			if p := filepath.Join(d, n); exists(p) {
				return p
			}
		}
	}
	return ""
}

// withPath returns the environment with dirs prepended to PATH.
func withPath(dirs ...string) []string {
	env := os.Environ()
	path := strings.Join(dirs, ":") + ":" + os.Getenv("PATH")
	for i, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			env[i] = "PATH=" + path
			return env
		}
	}
	return append(env, "PATH="+path)
}

// runCmd streams a command's output, indented, and returns its error.
func runCmd(dir string, env []string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir, cmd.Env = dir, env
	cmd.Stdin = nil
	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	err := cmd.Run()
	for _, l := range strings.Split(strings.TrimRight(buf.String(), "\n"), "\n") {
		if strings.TrimSpace(l) != "" {
			info("%s", l)
		}
	}
	if err != nil {
		return fmt.Errorf("%s %s: %w", filepath.Base(name), strings.Join(args, " "), err)
	}
	return nil
}

// output runs a command with a timeout and returns its combined output.
func output(timeout time.Duration, env []string, stdinText string, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = env
	if stdinText != "" {
		cmd.Stdin = strings.NewReader(stdinText)
	}
	out, err := cmd.CombinedOutput()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return string(out), fmt.Errorf("timed out after %s", timeout)
	}
	return string(out), err
}

// launch starts the launcher detached from this process.
func launch(launcher string) error {
	cmd := exec.Command(launcher)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("launch: %w", err)
	}
	return cmd.Process.Release()
}

// readEnvFile parses KEY=value lines; quotes around values are stripped.
func readEnvFile(path string) map[string]string {
	m := map[string]string{}
	b, err := os.ReadFile(path)
	if err != nil {
		return m
	}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		m[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
	}
	return m
}

func launcherHint(launcher string) string {
	if strings.Contains(":"+os.Getenv("PATH")+":", ":"+filepath.Dir(launcher)+":") {
		return filepath.Base(launcher)
	}
	return launcher
}
