//go:build wasip1

// The WASM interface for parser.mjs: alloc gives a buffer for the command line, and parse reads it and gives the
// JSON result as (pointer << 32 | length). Both buffers stay referenced until the next call.
package main

import "unsafe"

var input, result []byte

//go:wasmexport alloc
func alloc(n uint32) uint32 {
	input = make([]byte, n+1)
	return uint32(uintptr(unsafe.Pointer(unsafe.SliceData(input))))
}

//go:wasmexport parse
func parse(n uint32, zsh uint32) uint64 {
	result = Parse(string(input[:n]), zsh != 0)
	return uint64(uintptr(unsafe.Pointer(unsafe.SliceData(result))))<<32 | uint64(len(result))
}

func main() {}
