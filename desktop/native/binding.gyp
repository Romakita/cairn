# Module natif de Cairn (N-API pur, Command Line Tools seules). Compilation : `bun scripts/build-native.ts`
# (depuis desktop/), sortie build/Release/cairn_native.node, chargée par loadNative() (src/core/native.ts).
{
  "targets": [
    {
      "target_name": "cairn_native",
      "sources": ["src/cairn_native.m"],
      "defines": ["NAPI_VERSION=8", "NAPI_DISABLE_CPP_EXCEPTIONS"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "14.0",
        "OTHER_CFLAGS": ["-fobjc-arc", "-Wall", "-Wextra", "-Wno-unused-parameter"]
      },
      "link_settings": {
        "libraries": [
          "-framework Foundation",
          "-framework CoreFoundation",
          "-framework Security",
          "-framework NetFS"
        ]
      }
    }
  ]
}
