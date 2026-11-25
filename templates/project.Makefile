SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

.PHONY: help build run web clean rebuild configure validate tools docs editor add_component doctor test

help:
	@printf '%s\n' \
	  'ESPEmu project commands:' \
	  '  make build      Compile this firmware and create its QEMU flash image.' \
	  '  make run        Build this project, then start QEMU and the web view.' \
	  '  make web        Start QEMU/web using the existing firmware image.' \
	  '  make test       Build, then run the regression tests in test/.' \
	  '  make clean      Remove only this project build directory.' \
	  '  make rebuild    Clean and compile this project again.' \
	  '  make configure  Open ESP-IDF menuconfig.' \
	  '  make validate   Validate this project circuit manifest.' \
	  '  make doctor     Check local tools and build artifacts without modifying them.' \
	  '  make tools      Prepare the shared framework toolchains.' \
	  '  make docs       Refresh generated device docs/diagram; preserve user edits.' \
	  '  make editor     Refresh generated VS Code paths/tasks; preserve user edits.' \
	  '  make add_component  Add one simulated device to this project.' \
	  '  DEVICE=TYPE|JSON make add_component  Add one device without prompts.' \
	  '  Ctrl-C stops a running simulation. PORT=4002 make run selects a starting port.' \
	  '  ESPEMU_FRAMEWORK=/path/to/espemu overrides the recorded framework location.'

build run web clean rebuild configure validate tools docs editor add_component doctor test:
	@if [[ -n "$${ESPEMU_FRAMEWORK:-}" ]]; then \
	  framework="$$ESPEMU_FRAMEWORK"; \
	elif [[ -f .espemu-framework ]]; then \
	  IFS= read -r framework < .espemu-framework; \
	else \
	  printf '%s\n' 'Framework location missing. Set ESPEMU_FRAMEWORK=/path/to/espemu.' >&2; exit 2; \
	fi; \
	if [[ ! -f "$$framework/tools/project-command.sh" ]]; then \
	  printf '%s\n' 'Framework commands not found. Update .espemu-framework or set ESPEMU_FRAMEWORK.' >&2; exit 2; \
	fi; \
	exec bash "$$framework/tools/project-command.sh" "$@" "$$(pwd -P)"
