# Editify mobile

## Native auth configuration

Set `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` to a Google OAuth client ID of type Web. Set `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` to the iOS OAuth client ID for bundle ID `com.editify.app`. In Google Cloud, also create Android OAuth client IDs for package `com.editify.app` and every SHA-1 signing certificate used by local, EAS, and Play builds.

Before the next native build, replace `com.googleusercontent.apps.REPLACE_ME` in `app.json` with the reversed iOS client URL scheme. For an iOS client ID shaped like `123-example.apps.googleusercontent.com`, the scheme is `com.googleusercontent.apps.123-example`.

In Supabase Authentication Providers, enable Google with the web client secret and a comma-separated Client IDs list with the web client ID first, followed by the iOS and Android client IDs. Enable Apple and include the native App ID `com.editify.app` in Client IDs. If Editify also uses Apple's web/OAuth flow, create a Services ID, place it first in that list, and supply its generated Apple secret; native-only sign-in does not need the web OAuth secret rotation.
