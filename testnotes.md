# Test Notes

## Known environment-only test failures (`localStorage`)

`UserSettings` reads/writes the global `localStorage` directly. On some local
setups (Node 22+ ships an experimental `localStorage` that is `undefined`
unless `--localstorage-file` is passed), the `localStorage` global is missing,
so tests that touch `UserSettings` fail with:

```
TypeError: Cannot read properties of undefined (reading 'getItem' / 'removeItem')
```

Affected test files include:

- `tests/UserSettings.test.ts`
- `tests/InputHandler.test.ts`
- `tests/client/InputHandlerGestureZoom.test.ts`

These are environment-only failures, **not code regressions**: they pass in CI
(where jsdom provides a working `localStorage`) and on machines where
`localStorage` is available.
