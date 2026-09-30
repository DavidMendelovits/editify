# Editify Privacy Policy

**Last updated:** 30 September 2026
**Applies to:** the Editify iOS and Android apps (bundle id `com.editify.app`) and the Editify web client.

## 1. Who is responsible for your data

Maja Ventures SL ("Maja Ventures", "we") is the data controller for the personal data described here.

- Company: Maja Ventures SL
- Registered address: {{FILL_REGISTERED_ADDRESS}}
- Privacy contact: david.mendelovits@gmail.com

If you are in the EEA or the UK, you can contact us at the address above to exercise the rights described in section 8.

## 2. What Editify is, and where your footage goes

Editify is a video editor. The app is a client; the editing engine, the media store and the renderer run on a server operated by Maja Ventures at `https://editify-dm.fly.dev`.

**When you import a clip, the full original file is uploaded to that server.** It is not a proxy, a thumbnail or a downscaled copy: the file you picked is transferred and stored. The server then derives a low-resolution preview copy, a poster frame, a filmstrip, an audio waveform and, when the clip has sound, a speech transcript. All of those derived files are stored on the server too.

Your footage is stored on a persistent disk attached to that server. It is not encrypted at rest beyond the disk encryption the hosting provider applies, and it is not backed up to a separate location.

**One feature sends a video file off that server.** If you use "learn my style", the clips you submit to it are uploaded to Google's Gemini API so the model can watch them. This is the only case in which your footage leaves our own infrastructure. See section 5.

## 3. What we collect

### 3.1 Account data

- **Email address.** Required to create an account, whether you sign up with a password or with Google.
- **Password.** Stored only as a hash by our authentication provider; we never see it.
- **Account identifier.** A random user id issued at sign-up. Every project, clip, render and report you create is stored against it.
- **Name and profile picture URL.** If you sign in with Google, Google returns the profile fields attached to your Google account, and our authentication provider stores them with your login record. Editify itself does not display or use them.

### 3.2 Content you create or import

- Video, audio and image files you import, including the full originals.
- Voiceover recordings you make in the app with the microphone.
- Speech transcripts generated from the audio in your clips.
- Project documents: titles, timeline structure, clip trims, captions and caption text, sticker and callout text, clip labels.
- The chat messages you send to the editing assistant, and its replies.
- Rendered exports.

### 3.3 Diagnostic and usage data

The app keeps a rolling log of what you did in the current session (for example: app opened, project created, project opened, edit applied, chat message sent, render started, import performed) together with API calls that failed or were slow. **This log is sent to our server automatically, roughly once a minute, without a separate prompt.** With it we send:

- a random session identifier that is regenerated every time the app starts,
- the platform, app version, session length, window and screen size, pixel density and device time zone,
- on the web client only: browser user agent, language, network type, CPU core count, device memory, colour scheme and reduced-motion preference, and the route path (never the query string).

If the app crashes, or if you press "send feedback" and write a message, we also receive the error message, the JavaScript stack, the React component stack, whatever you typed, and a short description of the screen you were on (for example which project was open and how many clips it had). On the web client you may additionally choose to attach a screenshot; the app replaces frames, thumbnails, captions, chat turns and file names in that image with placeholders before it is sent. The iOS and Android apps do not capture screenshots at all.

### 3.4 Product analytics

Editify uses **PostHog**, a product-analytics service, to understand how the app is used. The PostHog software runs inside the app and reports to the PostHog instance named in section 5, which also gives the operating company and the region the data is hosted in.

What it receives:

- An **installation identifier** that PostHog generates on your device the first time you open the app and keeps until you delete the app. It is not your Apple advertising identifier, and we do not read that identifier anywhere.
- **Your Editify account identifier** while you are signed in: the random id of your account, not your email address or name. It links your analytics events and crash diagnostics to your account so we can investigate a problem you report. Signing out stops the link for that device.
- **Application lifecycle events**: when the app is installed, updated, opened and put into the background, with the app version and build number.
- **Automatic technical properties** attached to those events, such as the app version, operating system version, device type, language and screen dimensions.
- **Which screens of the app you open.** A screen can include the internal id of the project you have open, never its title. Individual taps and button presses are not captured. PostHog never receives the contents of your projects.
- **Crash and error diagnostics.** If the app crashes, or an error it does not expect occurs, PostHog receives the error type and message, the stack trace (which functions in the app's own code were running), the app version, and the technical properties above. For crashes in the app's native code, the report is sent the next time you open the app.

PostHog never receives your video, audio, transcripts, captions, chat messages, project titles or rendered exports. Nothing in the app sends PostHog your email address or your name.

### 3.5 Subscription data

If you buy an Editify subscription, the purchase is made through Apple's App Store or Google Play. **We never see your card, and no payment details are entered in the Editify app**; the payment sheet belongs to the store, and the store charges you.

We use **RevenueCat** to record which subscription you hold and to keep it working across your devices. What RevenueCat receives:

- Your **purchase history for Editify**: which plan was bought, when it started, whether a free trial was used, whether it renewed, expired or was refunded, and the store receipt behind it.
- Your **Editify account identifier**, which we deliberately hand to RevenueCat so that a subscription follows your account rather than the phone you bought it on. This is why signing in on a new device restores your plan.
- Technical details of the device and the store transaction.

RevenueCat does not receive your email address, your name, your card, or any of your content. We also record the fact that a subscription started in our own diagnostic log (section 3.3), against your account identifier.

Cancelling is done in your App Store or Google Play account settings. Deleting your Editify account (section 7) erases your Editify data but **does not cancel a store subscription** — only you can do that, in the store.

### 3.6 What we do not collect

We do not collect your precise or coarse location, contacts, health data, browsing or search history, or advertising identifiers. We never see or store your payment card details. Editify contains no advertising SDK. Crash reporting is handled by PostHog, as described in section 3.4.

**We do not track you across other companies' apps or websites**, and we do not sell or share your data for advertising. Neither the analytics software nor the subscription software in the app reads your device's advertising identifier, and the app never asks for permission to track you, because it does not.

## 4. Why we use it

| Data | Purpose | Legal basis (EEA/UK) |
|---|---|---|
| Email, password hash, account id, Google profile fields | Create and secure your account, keep your work separate from other users' | Performance of a contract |
| Imported media, transcripts, project documents, chat, renders | Provide the editor: playback, editing, transcription, captioning, rendering | Performance of a contract |
| Session event log, crash reports, feedback | Find and fix defects, understand which features are used | Legitimate interests in maintaining and improving the app |
| Product-analytics events and the anonymous installation identifier | Understand which parts of the app are used, and how often, so we can improve them | Legitimate interests in maintaining and improving the app |
| Subscription status, purchase history, account identifier held by our billing provider | Sell subscriptions, unlock paid features for the right account, handle renewals, restores and refunds | Performance of a contract |

We do not use your data for advertising, profiling or automated decisions with legal effects.

## 5. Who else processes it

These are the only third parties that receive your data, and they receive it because they run part of the service.

| Processor | What reaches them | Why |
|---|---|---|
| **Fly.io** (Fly.io, Inc., USA) | Everything stored server-side: your media files, transcripts, project documents, chat history, renders, diagnostic reports | Hosting for the Editify API, media store, database and renderer |
| **Supabase** (Supabase, Inc., USA) | Email address, password hash, account id, and any profile fields your identity provider returns | Authentication and session management |
| **Google** (Google LLC, USA) | Your Google account identity, if and only if you choose "continue with Google" | Sign-in |
| **Anthropic** (Anthropic PBC, USA) | The text of your chat messages, your project's timeline structure, your clips' file names and durations, the text of your transcripts and captions, and your style brief. Video and audio files are never sent to it. | Running the editing assistant |
| **Google (Gemini API)** (Google LLC, USA) | The **full video file** of each clip you submit to "learn my style". This analyzer is configured and active on our production server. The upload is deleted from Google's Files API at the end of the run. The app's style screen tells you which analyzer is active and whether it uploads footage. | Analysing your reference videos |
| **PostHog** (PostHog, Inc., USA; US cloud) | The installation identifier, your account identifier while signed in, application lifecycle events, screen views, crash and error diagnostics, and the technical properties listed in section 3.4. No content, no email address, no name | Product analytics and crash reporting: understanding how the app is used and finding what breaks |
| **RevenueCat** (RevenueCat, Inc., USA) | Your Editify account identifier, your Editify purchase history and store receipts, and technical details of the device and transaction. No card details, no email address, no content | Managing subscriptions and entitlements across your devices |
| **Apple** (Apple Inc., USA) and **Google** (Google LLC, USA), as the app stores | Your payment and billing relationship for any subscription you buy, under their own privacy policies. We receive a subscription status from them, never a payment instrument | Taking payment for subscriptions |
| **GitHub** (GitHub, Inc., USA) | Crash reports and feedback you send: the error text, the stack, the app-state summary, your session event log and anything you typed. On the web client, an attached screenshot is committed to a repository. | Filing bug reports into our issue tracker |

Our issue tracker is the **private** repository `DavidMendelovits/editify`. Reports filed there are readable by the people who maintain Editify and by GitHub as our processor. Nothing you send in a crash report or a feedback message is published publicly.

Confirmed on the production server (Fly app `editify-dm`, September 2026): the Anthropic key, the Gemini key and the GitHub token are all set, so the editing assistant runs on Anthropic's model, the Gemini analyzer is the one that watches your reference videos, and reports are filed into the private repository named above.

All of these providers are in the United States. PostHog stores our analytics in its US cloud region. Transfers out of the EEA and the UK rely on the providers' Standard Contractual Clauses.

## 6. How long we keep it

- Account data, media, transcripts, projects, chat history and renders: until you delete them, or until you delete your account.
- Deleting a project deletes its timeline, operation log, chat history and renders.
- Diagnostic and feedback reports: retained indefinitely while the underlying defect is open. Reports linked to your account are deleted when you delete your account; anonymous reports and any issue already filed in the tracker are not.
- Product-analytics events and crash diagnostics: retained according to our PostHog project's retention settings. Those sent while you were signed in carry your account identifier. Deleting your account does not yet remove them from PostHog automatically; contact us and we will delete them.
- Subscription records held by our billing provider: retained for as long as we need them to service the subscription and to meet accounting and tax obligations, which outlast the account itself.

## 7. Deleting your account

"Delete account" on the Editify home screen erases, in one step: every project you own and everything attached to it, every clip you imported along with its files on disk, every render output, every diagnostic report stored against your account, and your login itself. It cannot be undone.

If an issue was already filed in our tracker from one of your reports, the text of that issue is not removed automatically. Write to the privacy contact in section 1 and we will remove it.

**Deleting your Editify account does not cancel a subscription you bought in the App Store or Google Play.** Only you can cancel it, in your store account settings, and you should do that first. Deleting the account also does not erase the billing records our payment providers must keep for accounting and tax purposes.

## 8. Your rights

If you are in the EEA or the UK you have the right to access, correct, erase, restrict and object to the processing of your personal data, and the right to data portability. Most of these you can exercise inside the app: your content is visible and editable, and account deletion is one button. For anything else, write to the privacy contact in section 1. You also have the right to complain to your local supervisory authority.

If you are in California, you have the right to know what personal information we collect, to delete it, and to correct it. We do not sell personal information and we do not share it for cross-context behavioural advertising.

## 9. Children

Editify is not directed at children under 13, and we do not knowingly collect personal data from them. If you believe a child has created an account, write to the privacy contact in section 1 and we will delete it.

## 10. Security

Requests to the Editify API are authenticated with a signed token issued by our authentication provider, and every row is scoped to the account that created it. Traffic is served over HTTPS.

Two limitations are worth stating plainly. Media files are requested by players that cannot set HTTP headers, so the access token is placed in the URL query string for those requests; on iOS, opening a finished render hands such a URL to Safari. And your original footage is stored on the server in its original form. If either is a problem for the footage you work with, do not import it.

## 11. Changes

We will post any change to this policy at this URL and update the date at the top. Material changes will be announced in the app.
