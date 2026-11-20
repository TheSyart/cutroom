// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CutroomDictation",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "emperor-dictation-helper", targets: ["EmperorDictationHelper"]),
    ],
    targets: [
        // Editor dictation (VO-01): its own helper, microphone and speech only.
        .target(name: "DictationCore"),
        .target(
            name: "DictationPlatform",
            dependencies: ["DictationCore"],
            // AVFoundation and Speech callbacks are not Sendable-annotated.
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "EmperorDictationHelper",
            dependencies: ["DictationCore", "DictationPlatform"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(name: "DictationCoreTests", dependencies: ["DictationCore"]),
        .testTarget(
            name: "DictationPlatformTests",
            dependencies: ["DictationPlatform"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
