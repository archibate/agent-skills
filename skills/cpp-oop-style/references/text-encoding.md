# Text Encoding and Filesystem Paths

Load this reference when code handles Unicode, encodings, local paths, or text
crossing a library or platform boundary.

## Code units and bytes

Use `char` for narrow character/code-unit APIs, `char8_t` for explicitly typed
UTF-8 code units at C++20 boundaries, and `std::byte` for raw binary data.
`std::uint8_t` is an arithmetic integer, not a semantic byte. `unsigned char`
remains legitimate for C interoperability and inspecting object representations.

## Unicode text

Default application text to UTF-8 stored in `std::string`; this interoperates
best with existing libraries. Use `std::u8string` when a C++20 API benefits from
making UTF-8 code units distinct, and convert deliberately at legacy `char`
boundaries.

`wchar_t` is UTF-16-sized on Windows and UTF-32-sized on common Unix systems;
reserve it for platform APIs that require it. `char32_t` / `std::u32string` can
store Unicode code points, but they do not validate scalar values or model
grapheme clusters and are not a complete text abstraction.

## Filesystem paths

For C++20 filesystem boundaries, construct a path from UTF-8 code units and pass
the `path` itself to file APIs:

```cpp
auto const path = std::filesystem::path{std::u8string{u8"数据/report.csv"}};
auto input = std::ifstream{path};
```

For C++17, `std::filesystem::u8path(utf8String)` is the compatibility path. Do
not use it as the C++20 default: it was deprecated there after `char8_t`-aware
`path` construction became available.

Inside Qt code, follow `QString` / `QChar` conventions and convert at the module
boundary rather than forcing standard-library string policy through Qt APIs.
