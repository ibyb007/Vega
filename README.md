<img width="438" height="438" alt="logo@3x" src="https://github.com/user-attachments/assets/ffbdcc64-28af-4678-9903-458dbedeb90c" />
# Vega TV

An Android TV / Google TV fork of [Vega App](https://github.com/vega-org/vega-app), rebuilt for the big screen with remote-control (D-pad) navigation.

> **Credit:** This project is based on the original **[Vega App](https://github.com/vega-org/vega-app)** by **[himanshu8443](https://github.com/himanshu8443)** and its contributors. All credit for the original app, its architecture and its ideas goes to them. This fork is an independent project and is **not affiliated with or endorsed by** the original authors.

---

## About

Vega TV takes the mobile Vega App and adapts it for television:

- Built for Android TV and Google TV devices
- Full D-pad / remote navigation with focus handling
- Native (Kotlin) side navigation rail
- TV-style home, discover, search, details, source-select and settings screens
- Extension (provider) system running inside an isolated sandbox
- Metadata powered by the TMDB API (bring your own API key)

## Important notice

Vega TV is a **media player and browsing client only**.

- It **does not host, store, upload or distribute** any video, audio or other media.
- It **ships with no content, catalogs or streaming sources** of any kind.
- Any extensions or sources you add are provided by third parties. You are solely responsible for what you add and use, and for making sure it complies with the laws and terms of service that apply to you.
- Only use it with content you have the legal right to access.

The developers do not control, review or endorse any third-party content or extensions.

## Download

Release builds are published on the [Releases page](../../releases).

- **Stable** – regular releases
- **Canary** – test builds, may be unstable (marked as pre-release)

Pick the APK that matches your device:

| File ending | Use for |
|---|---|
| `arm64-v8a` | Most modern TV boxes and sticks (64-bit) |
| `armeabi-v7a` | Older 32-bit devices |

Install by sideloading the APK (for example with a file manager or `adb install`).

## Building

Builds are produced by the GitHub Actions workflow in `.github/workflows/tv.yml`.

1. Open the **Actions** tab and choose **Build Android TV Release APK**.
2. Click **Run workflow**, pick the branch and channel (`stable` or `canary`).
3. Download the APKs from the run artifacts or the generated release.

The workflow needs your own signing secrets configured in the repository: `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS` and `KEY_PASSWORD`.

For a local build you need Node.js 20, JDK 17 and the Android SDK:

```bash
npm ci
npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
```

Set `TMDB_API_KEY` in your environment (or enter it in the app settings) to enable TMDB metadata.

## Tech stack

React Native (Expo) · TypeScript · NativeWind · Kotlin native modules · React Query · Zustand

## Credits and acknowledgements

- **[Vega App](https://github.com/vega-org/vega-app)** – the original project this is forked from
- **[himanshu8443](https://github.com/himanshu8443)** – original author
- This product uses the TMDB API but is not endorsed or certified by [TMDB](https://www.themoviedb.org/).
- Thanks to the open-source libraries this project depends on. See `package.json` for the full list.

## License

Licensed under the **Apache License 2.0**, the same license as the original project. See [LICENSE](LICENSE).

Modifications in this fork were made for Android TV / Google TV support.

## Trademarks

Android and Android TV are trademarks of Google LLC. Google TV is a trademark of Google LLC. All other names are the property of their respective owners. They are used here only to describe device compatibility, and this project is not affiliated with or endorsed by Google or any other trademark holder.
