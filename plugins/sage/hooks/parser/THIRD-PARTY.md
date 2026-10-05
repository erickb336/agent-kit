# Third-party code in parser.wasm

`parser.wasm` contains code from the components below. Each licence file in this folder is a verbatim copy of the upstream file at the pinned tag or commit.

| Component | Version or commit | Licence | Licence file | Source | Why it is in parser.wasm |
| --- | --- | --- | --- | --- | --- |
| mvdan/sh | v3.14.1 | BSD-3-Clause | [LICENSE-mvdan-sh](LICENSE-mvdan-sh) | [mvdan/sh LICENSE](https://github.com/mvdan/sh/blob/v3.14.1/LICENSE) | The shell parser itself: package `mvdan.cc/sh/v3/syntax`. |
| TinyGo runtime and its `src/` | v0.42.0 | BSD-3-Clause | [LICENSE-tinygo](LICENSE-tinygo) | [tinygo LICENSE](https://github.com/tinygo-org/tinygo/blob/v0.42.0/LICENSE) | TinyGo replaces these Go packages with its own: `runtime` (with the heap, `malloc`, `free`, `fminimum`), `reflect`, `internal/reflectlite`, `internal/task`, `internal/bytealg`, `internal/itoa`, `sync`, `syscall`, `unicode`, `unicode/utf8`. |
| Go standard library | go1.26.8 | BSD-3-Clause | [LICENSE-go](LICENSE-go) | [go LICENSE](https://github.com/golang/go/blob/go1.26.8/LICENSE) | The other Go packages come from Go's own source: `fmt`, `encoding/json`, `regexp`, `regexp/syntax`, `strconv`, `internal/strconv`, `strings`, `bytes`, `slices`, `sort`, `errors`, `cmp`, `internal/fmtsort`, `internal/stringslite`. |
| wasi-libc | 1dfe5c302d1c5ab621f7abf04620fae92700fd22 (the submodule `lib/wasi-libc` of TinyGo v0.42.0) | Apache-2.0 WITH LLVM-exception, Apache-2.0 and MIT | [LICENSE-wasi-libc](LICENSE-wasi-libc), with [LICENSE-wasi-libc-APACHE-LLVM](LICENSE-wasi-libc-APACHE-LLVM), [LICENSE-wasi-libc-APACHE](LICENSE-wasi-libc-APACHE) and [LICENSE-wasi-libc-MIT](LICENSE-wasi-libc-MIT) | [wasi-libc LICENSE](https://github.com/WebAssembly/wasi-libc/blob/1dfe5c302d1c5ab621f7abf04620fae92700fd22/LICENSE) | TinyGo links the C library for `wasip1`. wasi-libc's own code gives `arc4random`, `arc4random_buf` and `chacha20_*` (`libc-top-half/sources/arc4random.c`), `__getentropy` and `__wasi_random_get` (`libc-bottom-half/sources/`). |
| musl, as part of wasi-libc | the same wasi-libc commit | MIT | [COPYRIGHT-musl](COPYRIGHT-musl) | [musl COPYRIGHT in wasi-libc](https://github.com/WebAssembly/wasi-libc/blob/1dfe5c302d1c5ab621f7abf04620fae92700fd22/libc-top-half/musl/COPYRIGHT) | wasi-libc's musl part gives `strlen` (`src/string/strlen.c`) and a weak stub named `dummy`. |
| compiler-rt builtins | tinygo-org/llvm-project 2be7242b6a4d59fe89fb43f7d1e7333dc9b307a2 (TinyGo v0.42.0's `llvm-version.txt`; LLVM 22.1.4) | Apache-2.0 WITH LLVM-exception | [LICENSE-compiler-rt](LICENSE-compiler-rt) | [compiler-rt LICENSE.TXT](https://github.com/tinygo-org/llvm-project/blob/2be7242b6a4d59fe89fb43f7d1e7333dc9b307a2/compiler-rt/LICENSE.TXT) | `__multi3` (`multi3.c`), the 128-bit multiply that the Go code calls. The LLVM exception does not require this notice for code compiled into an object, but the notice costs nothing. |

## How the list was made

The list comes from the function names in the `name` section of `parser.wasm` (651 functions), and from the TinyGo v0.42.0 source:

- A Go package is from TinyGo when TinyGo v0.42.0 has the folder `src/<package>`; otherwise it is from Go's standard library.
- A C function is matched to its source file in wasi-libc at the pinned commit.
- The `producers` section names clang 22.1.4 from tinygo-org/llvm-project at 2be7242b, the same commit as TinyGo's `llvm-version.txt`.

These components are not in `parser.wasm`, so they have no file here:

- wasi-libc's `cloudlibc` part (BSD-2-Clause): no function from it is in the name section.
- `dlmalloc` and `emmalloc` (wasi-libc): TinyGo's runtime defines `malloc`.
- LLVM, clang and Binaryen: they are tools that make the file, not code in it.
