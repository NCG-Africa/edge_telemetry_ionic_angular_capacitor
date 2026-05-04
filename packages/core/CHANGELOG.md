# @nathanclaire/rum

## 1.0.5

### Patch Changes

- fix: move @nathanclaire/rum to peerDependencies in rum-angular; add deferFlush config and Pipeline.markReady() to prevent first-batch device_id race condition

## 1.0.4

### Patch Changes

- fix: include device_id at batch payload root level for collector server compatibility

## 1.0.3

### Patch Changes

- fix: flatten batch payload to match collector server schema — `events` is now a top-level field instead of nested under `data.events`
