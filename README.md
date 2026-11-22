# Home Alerts

A private alternative to sign-up alert services. Every 15 minutes it checks official UK feeds for Beverley, Sheffield, Mirfield and Selby, sends anything new to your Android phone as a notification, and keeps a page you can add to your home screen.

You never give anyone your name, email or postcode. The only things it knows are the four town names and rough map points in `config.json`.

## What it watches

| Check | From | Official? |
|---|---|---|
| Severe weather warnings (yellow, amber, red) | Met Office, Yorkshire & Humber feed | Yes |
| Flood alerts and warnings within a few km of each place | Environment Agency | Yes |
| Cold and heat health alerts | UKHSA (the feed behind their public dashboard) | Yes |
| Strong gusts, snow, heavy rain, very cold or hot days, next 3 days | Open-Meteo forecast | No, a heads-up |
| Frost or heat for the rabbits at home | Open-Meteo forecast | No, a heads-up |
| "Worth a call" nudge for Dad on very cold or hot days | Open-Meteo forecast | No, a heads-up |
| Poor air quality at home or Dad's | Open-Meteo air quality | No, a heads-up |
| River levels: Hull (Beverley), Calder (Mirfield), Ouse (Selby), with a heads-up if above normal or rising fast | Environment Agency | Measurement |
| Food recalls, last 14 days (non-food product recalls can be switched on) | Food Standards Agency, GOV.UK | Yes |
| Flu, COVID-19 and RSV test positivity in England, with trend | UKHSA data dashboard | Yes |

You also get a morning summary at 7am, a message when a warning ends, and a message if a feed stops answering for about 2 hours.

**Not automatic yet: power cuts.** Northern Powergrid does not publish a documented live feed, so the page links to their live map and to 105 instead.

## How it works

```
GitHub (free) runs the checker every 15 min
   ├─ reads Met Office, Environment Agency, UKHSA, Open-Meteo
   ├─ sends new alerts ──▶ ntfy app on your phone (notification)
   └─ publishes the page ──▶ your-name.github.io/home-alerts (add to home screen)
```

Nothing runs on your phone except the free ntfy app and the page, so it works even when the phone is asleep.

## Setup (about 20 minutes, once)

You need a computer for steps 2 to 5. After that everything is on the phone.

### 1. Install ntfy on your phone

1. Install **ntfy** from the Google Play Store (it is free and needs no account).
2. Tap **+**, and make up a long topic name nobody could guess, for example `beverley-home-7Kq2mX9v`. Anyone who knows the name can read the messages, so treat it like a password.
3. Leave the server as `ntfy.sh` and tap **Subscribe**.

### 2. Make a free GitHub account

Go to github.com and sign up. A spare email address is fine. You do not need to pay for anything.

### 3. Put these files on GitHub

1. Click **+** (top right) then **New repository**. Name it `home-alerts`, choose **Public**, and click **Create repository**.
2. Click **uploading an existing file**. Unzip `home-alerts.zip` on your computer and drag everything inside the `home-alerts` folder into the page, including the `.github` folder. Click **Commit changes**.
   - The `.github` folder is hidden on a Mac. Press **Cmd + Shift + .** in Finder to see it.
   - If the upload skips it, click **Add file**, **Create new file**, type `.github/workflows/alerts.yml` as the name, paste in the contents of that file, and commit.

### 4. Turn on the page and add your topic

1. In the repository, go to **Settings**, then **Pages**. Under **Source**, choose **GitHub Actions**.
2. Go to **Settings**, **Secrets and variables**, **Actions**, then **New repository secret**. Name it `NTFY_TOPIC` and paste the topic name from step 1.

### 5. Start it

1. Open the **Actions** tab. If asked, click the button to enable workflows.
2. Click **Home alerts** on the left, then **Run workflow**.
3. Within a minute or two your phone should get "Home Alerts is set up".

### 6. Add the page to your phone

1. In Chrome on the phone, open `https://YOUR-GITHUB-NAME.github.io/home-alerts/`.
2. Tap the **⋮** menu, then **Add to Home screen** (or **Install app**).

### 7. Make the 15-minute checks reliable (recommended)

GitHub's own schedule is often hours late on small repositories. A free outside timer fixes this by pressing "Run workflow" for you.

**Make a limited GitHub key**
1. On GitHub, click your picture (top right), then **Settings**, **Developer settings**, **Personal access tokens**, **Fine-grained tokens**, **Generate new token**.
2. Name it `home-alerts timer`. Set the longest expiry offered and put a reminder in your calendar to renew it.
3. Under **Repository access**, choose **Only select repositories** and pick `home-alerts`.
4. Under **Permissions**, **Repository permissions**, set **Actions** to **Read and write**. Leave everything else as it is.
5. Click **Generate token** and copy it. You only see it once.

**Set up the timer**
1. Sign up free at cron-job.org and click **Create cronjob**.
2. Title: `Home alerts`. URL: `https://api.github.com/repos/YOUR-GITHUB-NAME/home-alerts/actions/workflows/alerts.yml/dispatches`
3. Schedule: **Every 15 minutes**.
4. Open the **Advanced** tab:
   - Request method: **POST**
   - Headers: `Accept` = `application/vnd.github+json`, `Authorization` = `Bearer ` followed by your token, `X-GitHub-Api-Version` = `2022-11-28`
   - Request body: `{"ref":"main"}`
5. Click **Test run**. A response of **204** means it worked, and a new run appears on your Actions tab.
6. Click **Create**.

## Changing things

Edit `config.json` on GitHub (open it, click the pencil, then **Commit changes**). The next run uses your changes.

- **Places**: add, remove or move a place. Get the map point by long-pressing on Google Maps.
- **Sheffield in summer**: the `months` list pauses Sheffield from June to August. Remove the line to watch it all year.
- **How sensitive heads-ups are**: the numbers under `thresholds`.
- **Rivers**: `riverWithinKm` sets how far to look for gauges, `rivers` names which river to prefer, and `riverRiseM3h: false` turns off the "rising fast" check for tidal rivers like the Hull at Beverley and the Ouse at Selby.
- **Recalls**: under `recalls`, choose whether food recalls send a quiet notification, whether to include allergy alerts, and `showProductRecalls` to add non-food recalls.
- **Fewer messages**: set `sendForecastHeadsUps` to `false` to only hear about official warnings. Set `dailySummaryHour` to `null` to stop the morning summary.
- **Privacy**: the repository and page are public, so anyone who finds them sees which towns you watch. They do not see who you are. You can blank the `who` labels if you prefer.

In ntfy, tap the topic, then the bell, to choose which priority levels make a sound. Red warnings are sent at the highest priority.

## Good to know

- GitHub sometimes runs the schedule 5 to 20 minutes late at busy times.
- GitHub pauses schedules on repositories that have had no changes for 60 days. The checker asks GitHub to keep it on, but if you get an email saying it was disabled, click the link and re-enable it.
- The UKHSA feed is the one their dashboard uses but is not formally documented. If it stops, the Sources list on the page turns red and you get a message.
- This is not an official warning service. For a power cut call 105, for flooding Floodline on 0345 988 1188, and in an emergency 999.
- Met Office warnings are © Crown copyright, Met Office. Flood data © Environment Agency. Forecasts from Open-Meteo.com (CC BY 4.0).

## Testing on a computer (optional)

With Node 18 or newer: `node checker/check.mjs`. It prints what it would send if `NTFY_TOPIC` is not set, and writes `site/status.json`.
