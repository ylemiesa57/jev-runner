// jev-runner-setup installs and configures Jev Runner on a Mac:
// Node.js, the embedded Electron app, a validated TypeSafe key, browser-harness, and a launcher.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const version = "0.1.0"

type options struct {
	appDir      string
	key         string
	yes         bool
	skipHarness bool
	noRun       bool
}

func usage() {
	fmt.Fprintf(os.Stderr, `jev-runner-setup %s — install Jev Runner (Electron + TypeSafe Jev + browser-harness)

Usage:
  jev-runner-setup [install] [flags]   install or update everything (default)
  jev-runner-setup doctor              check each component and report
  jev-runner-setup run                 launch the installed app
  jev-runner-setup version

Flags for install:
  --app-dir DIR        where the app lives (default ~/.jev-runner/app)
  --typesafe-key KEY   TypeSafe API key (else $TYPESAFE_API_KEY, existing .env, or a prompt)
  --yes                non-interactive: accept defaults, never prompt
  --skip-harness       do not install or check browser-harness (page actions will be unavailable)
  --no-run             do not offer to launch the app when done
`, version)
}

func main() {
	sub, args := "install", os.Args[1:]
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub, args = args[0], args[1:]
	}
	switch sub {
	case "install":
		os.Exit(install(args))
	case "doctor":
		os.Exit(doctor(args))
	case "run":
		os.Exit(runApp(args))
	case "version", "--version", "-v":
		fmt.Println("jev-runner-setup", version)
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", sub)
		usage()
		os.Exit(2)
	}
}

func parse(args []string) (options, *flag.FlagSet) {
	var o options
	fs := flag.NewFlagSet("jev-runner-setup", flag.ExitOnError)
	fs.Usage = usage
	fs.StringVar(&o.appDir, "app-dir", filepath.Join(home(), ".jev-runner", "app"), "")
	fs.StringVar(&o.key, "typesafe-key", "", "")
	fs.BoolVar(&o.yes, "yes", false, "")
	fs.BoolVar(&o.skipHarness, "skip-harness", false, "")
	fs.BoolVar(&o.noRun, "no-run", false, "")
	_ = fs.Parse(args)
	return o, fs
}

func install(args []string) int {
	o, _ := parse(args)
	if runtime.GOOS != "darwin" {
		fail("Jev Runner drives macOS (open, osascript, screencapture); this is %s.", runtime.GOOS)
		return 1
	}
	fmt.Printf("Jev Runner setup %s → %s\n", version, o.appDir)

	step("Node.js")
	nodeBin, err := ensureNode(o.yes)
	if err != nil {
		fail("%v", err)
		return 1
	}

	step("App")
	if err := installApp(o.appDir, nodeBin); err != nil {
		fail("%v", err)
		return 1
	}

	step("TypeSafe")
	if err := setupTypeSafe(o.appDir, o.key, o.yes); err != nil {
		fail("%v", err)
		return 1
	}

	step("browser-harness")
	if o.skipHarness {
		warn("skipped (--skip-harness); browser_click / browser_type will not work")
	} else if _, err := setupHarness(o.yes); err != nil {
		warn("%v", err)
		warn("everything else still works; page actions will fail until this is fixed (rerun `jev-runner-setup doctor`)")
	}

	step("Launcher")
	launcher, err := installLauncher(o.appDir, nodeBin)
	if err != nil {
		fail("%v", err)
		return 1
	}

	step("Permissions")
	fmt.Println("  Native clicks, typing, and window titles use System Events. If the app cannot see or")
	fmt.Println("  click anything, grant Accessibility to the app that launches it (Terminal, iTerm, or")
	fmt.Println("  Electron) at System Settings → Privacy & Security → Accessibility.")

	fmt.Println()
	ok("installed. Start it with:  %s   (or: jev-runner-setup run)", launcherHint(launcher))
	if !o.noRun && confirm("Launch Jev Runner now?", true, o.yes) {
		if err := launch(launcher); err != nil {
			fail("%v", err)
			return 1
		}
		ok("launched")
	}
	return 0
}

func runApp(args []string) int {
	o, _ := parse(args)
	launcher := filepath.Join(home(), ".local", "bin", "jev-runner")
	if !exists(launcher) {
		if !exists(filepath.Join(o.appDir, "node_modules", ".bin", "electron")) {
			fail("not installed; run `jev-runner-setup install` first")
			return 1
		}
		nodeBin, err := ensureNode(true)
		if err != nil {
			fail("%v", err)
			return 1
		}
		if launcher, err = installLauncher(o.appDir, nodeBin); err != nil {
			fail("%v", err)
			return 1
		}
	}
	if err := launch(launcher); err != nil {
		fail("%v", err)
		return 1
	}
	ok("launched")
	return 0
}
