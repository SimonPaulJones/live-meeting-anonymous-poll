# Live Meeting Anonymous Poll

A simple web page for asking a group a question during a video call and getting **honest, anonymous answers**, live.

Some questions are hard to answer out loud in front of colleagues: *"Have you ever felt like an impostor at work?"*,
*"Is your workload manageable?"*, *"Did that change make your job harder?"*. When nobody can see who picked what,
people answer honestly, and everyone gets to see how common a feeling really is.

![The host's screen showing results as a bar chart](docs/screenshots/5-host-bar.png)

## How it works on a call

1. **Log in as a host** with the host password. That starts a new, empty poll room with its own link,
   like `yoursite.com/livepoll/6a39e359380f6c32`.
2. **Send everyone the link** in the meeting chat (it's at the top of your screen, with a **Copy link** button;
   close that box with **×** once everyone's in, and bring it back from the ⋯ menu).
   There's no password for them: the link takes them straight in. They see *"Waiting for the next question…"*.
3. **Share your screen**, and **ask your question** out loud. The answers are *Yes / Maybe / No* unless you type your own, one per line.
4. **Press Go.** The buttons appear on everyone's screen straight away. Nobody needs to refresh.
5. **People tap an answer.** They can change their mind until you close voting.
6. **Reveal the results** when you're ready, or let everyone watch them come in live.

Several hosts can run polls at the same time. Each login gets its own room, completely separate from everyone
else's, and hosts can't see each other's rooms.

<p>
  <img src="docs/screenshots/3-phone-vote.png" width="260" alt="Voting on a phone">
  &nbsp;
  <img src="docs/screenshots/8-phone-results.png" width="260" alt="Results on a phone after they are revealed">
</p>

## What the host can do

Everything the host needs fits on one screen, because that's the screen everyone is watching.

- **New poll:** an optional question, the answers (one per line), and a **↺ Yes / Maybe / No** button to reset to the usual three.
- **Live or reveal later:** show results as votes arrive, or keep them hidden until you click **Reveal results**.
  While they're hidden, everyone only sees how many people have voted.
- **Show as:** a bar chart, a pie chart or just big numbers. You can switch at any time.
- **Include:** how many people are here, the number of votes, percentages, and a "Didn't vote" slice.
- **Close voting** to freeze the answers, and **Reopen** if you need to.
- **The ⋯ menu:** show or copy the link for voters, copy a host link to run the poll from another device, or
  **delete the poll** when the meeting is over (the link then just shows *"404 Poll not found"*).
- Polls that nobody has had open for a day are deleted automatically.

![Setting up a new poll](docs/screenshots/2-host-setup.png)

<img src="docs/screenshots/1-start.png" width="600" alt="The host login, which starts a new poll">

| Hidden until you reveal | Pie chart | Big numbers |
|---|---|---|
| ![Votes hidden](docs/screenshots/4-host-waiting.png) | ![Pie chart](docs/screenshots/6-host-pie.png) | ![Numbers](docs/screenshots/7-host-numbers.png) |

## Is it really anonymous?

Yes. Nobody gives a name or an email address, and the page never asks who you are. Each browser gets a random
code just so it can't vote twice, and that code isn't linked to any person. The host only ever sees totals, the same
as everyone else. While results are hidden, the totals aren't even sent to anyone's screen.

## Putting it on your own website

You need ordinary web hosting that runs **PHP** (version 5.6 or newer) on Apache with `mod_rewrite` (for the
short poll links). On nginx, send `^/<folder>/[a-f0-9]{16}$` to `room.php` and block the `data` folder yourself.
Without that, links fall back to `…/?p=<poll>`. There's no database and nothing to install.

1. Copy everything inside the `public` folder to a folder on your website, for example `yoursite.com/poll/`.
2. In that folder, make a copy of `config.example.php` called `config.php`, open it and choose the host password.
   You can also change how long unused polls are kept (24 hours to start with).
3. Make sure the web server can write to the `data` folder (that's where the polls are kept).
4. Open the address in your browser. That's it.

The password isn't case sensitive. Give it to everyone who should be able to run polls.

### For developers

- `public/index.html`, `app.js` and `app.css` are the whole page: plain HTML, CSS and JavaScript, no frameworks.
  Pages check for updates about once a second.
- `public/api.php` is the server side. Each room is saved as a file in `public/data/rooms/`, which the included `.htaccess`
  blocks from the web (on Apache; on other servers, block that folder yourself).
- `node scripts/screenshots.js` checks the main screens in a headless browser (with a stand-in for `api.php`, so no
  PHP or server is needed) and saves the screenshots in `docs/screenshots/` at the same time.
- `scripts/deploy.sh` copies the site to a server over SSH. Copy `scripts/deploy.env.example` to `scripts/deploy.env`
  and fill in your server details first.

## Licence

Copyright © 2026 Simon Paul Jones.

This is free software under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0). In plain terms:

- You can use it, change it and share it, free of charge.
- If you share it, or a changed version of it, you must share the source code too, under the same licence.
- If you run a changed version as a website for other people, you must offer them its source code as well.

So it stays free for everyone, and nobody can take it and lock it away.
