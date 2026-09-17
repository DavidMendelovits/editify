# Editify mobile

## Running it

Google sign-in needs a native module Expo Go does not ship, so development runs on a **dev client** rather than Expo Go.

```bash
npm run dev:mobile:ios      # builds the native app, installs it, starts Metro
npm run dev:mobile          # Metro only, once the dev client is installed
```

The `ios/` and `android/` directories are generated from `app.json` by `expo prebuild` and are gitignored — never edit them by hand, and re-run the build after changing `app.json` or adding a native dependency. `npm run prebuild -w @editify/mobile --  --clean` regenerates them from scratch.

For a device build, `eas build --profile development --platform ios`.

## Native auth configuration

Set `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` to a Google OAuth client ID of type Web. Set `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` to the iOS OAuth client ID for bundle ID `com.editify.app`. In Google Cloud, also create Android OAuth client IDs for package `com.editify.app` and every SHA-1 signing certificate used by local, EAS, and Play builds.

The `@react-native-google-signin/google-signin` plugin in `app.json` carries the reversed iOS client URL scheme. For an iOS client ID shaped like `123-example.apps.googleusercontent.com`, the scheme is `com.googleusercontent.apps.123-example`.

In Supabase Authentication Providers, enable Google with the web client secret and a comma-separated Client IDs list with the web client ID first, followed by the iOS and Android client IDs. Apple sign-in is not wired up.

## Store submission

App icons live in `assets/` and are wired into `app.json` (`icon`, `splash`, `android.adaptiveIcon`, `web.favicon`). Store builds and uploads:

```bash
eas build --profile production --platform ios       # or android
eas submit --profile production --platform ios      # or android
```

The rest needs the owner's accounts and cannot be done from this repo:

- **App Store Connect**: create the app record for `com.editify.app`, then fill `submit.production.ios` in `eas.json` with the ASC app ID, Apple Team ID, and Apple ID. It is intentionally empty — do not commit placeholder IDs.
- **Google Play Console**: create the app for `com.editify.app` and generate a service-account JSON key for `submit.production.android.serviceAccountKeyPath`.
- **Privacy policy URL** — required by both stores before review.
- **Store listing assets**: screenshots per device class, description, category, content rating.
- **Google OAuth Android client IDs** for every Play signing SHA-1 (Play App Signing re-signs the upload, so its SHA-1 differs from EAS'). See "Native auth configuration" above.
