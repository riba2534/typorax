# macOS host

TyporaX uses AppKit for the window, document dialogs and menus, and WKWebView for the offline editor. The bundle loads `Contents/Resources/web/index.html`; it does not run a local web server.

Build the web UI first, then run `bash scripts/build-macos.sh`. The script compiles with the active Xcode toolchain, packages `build/TyporaX.app`, creates the original AppKit-drawn icon, ad-hoc signs the app and runs the native file tests. The default target architecture is `uname -m`; `ARCH=arm64` and `ARCH=x86_64` override it. macOS 14 or later is required. The project uses only macOS system frameworks in the host.

## Bridge

The editor sends `window.webkit.messageHandlers.typorax.postMessage({id, method, params})`. The host accepts messages only from the main frame of its bundled entry page. Responses are JSON values passed to `window.__typoraxResolve({id, result})` or `{id, error: string}`.

| Method | Parameters | Result |
| --- | --- | --- |
| `bootstrap` | none | `{documents, folder, activePath}`; restores state and includes queued Finder opens |
| `ready` | none | `{ok:true}`; frontend has restored drafts and activated `activePath`, so queued opens/menu commands can be delivered |
| `openFile` | none | `{id,path,name,content}` or null when cancelled |
| `openFolder` | none | `{path,name,files:[{path,name,relativePath}],truncated}` or null |
| `refreshFolder` | `{path}` | the updated admitted folder listing |
| `readFile` | `{path}` | a UTF-8 document; no implicit path authorization |
| `saveFile` | `{path,content,name?,saveAs?}` | `{path,name}` or null; a missing path opens Save As |
| `exportHTML` | `{html,name}` | `{path}` or null |
| `exportPDF` | `{html,name}` | `{path}` or null |
| `chooseImage` | none | `{url,markdownPath}` as self-contained data URIs or null |
| `resolveImage` | `{path,documentPath}` | a data URI for a raster image inside the admitted document directory |
| `setDirty` | `{dirty,name}` | `{ok:true}`; dirty should aggregate all open tabs |
| `revealFile` | `{path}` | `{ok:true}` for an admitted path |
| `closeConfirmed` | none | closes only after the editor has finished saving all modified documents |

Native menu commands invoke `window.__typoraxCommand(command)`; supported commands are `new`, `open`, `openFolder`, `save`, `saveAs`, `exportHTML`, `exportPDF`, `find`, `source`, `focus`, `theme`, `shortcuts`, and `saveAndClose`. Finder Open With calls `window.__typoraxOpenDocument(document)` after startup or includes pending documents in `bootstrap`.

The host owns standard macOS menu shortcuts. The web editor should not also intercept the same Command shortcuts in native mode.

## Files and restoration

Only native-picker/OS-selected files and workspaces are admitted. The most recent 100 canonical file paths and 100 workspace paths persist in app preferences. Restoring authorization does not follow a symlink that replaced a previously selected pathname. A save to an existing path requires an in-session read and a byte comparison with that read; external edits produce an error instead of being overwritten. Save As has its own native overwrite confirmation. Writes use Foundation's atomic replacement.

The frontend owns draft recovery and tab state. Before restoring a dirty saved document, it should read the current file and compare it with its last saved content; an externally changed file must be preserved, with recovered edits kept separately.

The frontend prioritizes the explicit `bootstrap.activePath` over a restored active tab. It calls `ready` only after restoration and activation finish. The host keeps later Finder opens and menu commands queued until this handshake, including during a WebKit reload.

Document reads and saves are limited to 32 MiB of UTF-8 text; an oversized save preserves the existing file. Raster image insertion supports PNG/JPEG/GIF/WebP/BMP, up to 20 MiB, and embeds the bytes in Markdown. Workspace scanning skips hidden/package directories and symlinks, limits traversal to 20,000 entries and reports at most 2,000 documents with explicit `truncated` state.

## PDF

PDF export uses an isolated, nonpersistent WKWebView with page-authored JavaScript disabled. WebKit produces vector PDF content, then CoreGraphics paginates it into A4 sheets with 36-point margins. Paragraph/block boundaries are preferred when they fit. Very tall individual blocks may split across pages. The operation has a 30-second budget and an explicit 200,000 CSS-pixel document-height bound. It does not use the macOS printer configuration.

## Validation entry points

```sh
build/TyporaX.app/Contents/MacOS/TyporaX --self-test
build/TyporaX.app/Contents/MacOS/TyporaX --pdf-self-test
build/TyporaX.app/Contents/MacOS/TyporaX --web-smoke-test
build/TyporaX.app/Contents/MacOS/TyporaX --integration-self-test
```

File tests run in a unique temporary directory and isolated preferences suite. PDF tests generate a temporary multi-page document and check its text. Web smoke tests use an isolated preferences suite and nonpersistent WKWebView, briefly open the application, check that the editable surface and bridge initialized without JavaScript errors, and exit. Normal launches have no test hooks enabled.

The integration entry point runs the bundled production frontend in a nonpersistent WKWebView with an isolated UserDefaults suite. It drives DOM editing and production controls, crosses the real JavaScript/Swift bridge, and verifies file contents, folder authorization, image rendering, HTML/PDF output, external-edit rejection, and saving all dirty documents before the native window actually closes. It also exercises Finder opens both before bootstrap and between bootstrap and `ready`. Its files and preferences are deleted on completion; it never uses the normal app's drafts or file authorization history.

Only system file-picker results and save/cancel close-alert choices are injected. Native picker presentation, physical keyboard/mouse input, and macOS permission dialogs are **not** verified by this automated entry point. No test IPC server or remote-control endpoint is installed. The compiler source list must include `NativeIntegrationTests.swift`.
