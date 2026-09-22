// Package jevrunner embeds the Electron app so the installer is a single binary.
package jevrunner

import "embed"

// App holds everything `npm install` needs to turn a directory into a runnable Jev Runner.
// node_modules and .env are deliberately not here: the installer creates those on the machine.
//
//go:embed src package.json scripts README.md
var App embed.FS
