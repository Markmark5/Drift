DRIFT TRACKER — STANDALONE SETUP & OPERATING GUIDE
===================================================

WHAT'S IN THIS FOLDER
---------------------
index.html        — the card wall (the page you open)
drift-index.json  — the data file (one entry per ticker)
STAF.html         — first ticker dashboard (Staffline, v3.13 audited)

Future ticker dashboards go in this same folder as TICKER.html
(MTO.html, QTX.html, GBG.html ...). Always the same filename per
ticker — a new build overwrites the old file.


ONE-TIME SETUP (GitHub)
-----------------------
1. Go to your GitHub Pages repo (the one serving markmark5.github.io pages).
2. Click "Add file" -> "Upload files".
3. Drag this whole folder in so the repo contains a folder called: drift
   (If GitHub flattens the folder: create the folder first by clicking
   "Add file" -> "Create new file", typing  drift/placeholder.txt ,
   committing, then uploading the three files into that folder and
   deleting placeholder.txt.)
4. Commit.
5. Open:  https://markmark5.github.io/[REPO-NAME]/drift/index.html
   You should see the STAF card. Click it — the STAF dashboard pops up.

That's the whole install.


ADDING A NEW TICKER (after each Turn 2 build)
---------------------------------------------
1. Save the new dashboard HTML as  TICKER.html  (e.g. MTO.html).
2. Upload it into the  drift  folder on GitHub (Add file -> Upload files).
3. Edit  drift/drift-index.json  on GitHub (pencil icon) and paste the
   index entry that Claude outputs at the end of the build, following
   the FIND -> PASTE instructions given with it.
4. Commit. The card wall updates on next open (GitHub Pages can take
   ~1 minute to refresh after a commit).

UPDATING AN EXISTING TICKER (rebuild / incremental)
---------------------------------------------------
1. Upload the new  TICKER.html  over the old one (same filename —
   GitHub replaces it automatically).
2. Edit drift-index.json: replace that ticker's entry with the new one
   Claude outputs. Commit.

REMOVING A TICKER
-----------------
Delete its entry from drift-index.json (from its opening { to its
closing } — and the comma joining it to its neighbour). The HTML file
can stay or be deleted; an entry-less HTML is simply unreachable
from the wall.


THE JSON — FIELD MEANINGS (locked contract, do not rename fields)
-----------------------------------------------------------------
ticker        "MTO"                       — must match your scorecard ticker codes
company       "Mitie Group PLC"
direction     "up" | "down" | "watch"     — sets the card colour
headline      the verdict card's <=25-word headline
trigger       "1-of-3" etc.
alert         true if 2-of-3 fired or Tier-1 flag, else false
rns_type      "FY Results" etc.           — the Buy/Sell RNS
rns_date      "2026-06-04"                — YYYY-MM-DD
build_date    "2026-07-28"
spec_version  "v3.14"
next_test     "H1 FY27 TU ~Oct-26" or "—"
url           "MTO.html"                  — filename only, same folder


LATER (not now): WIRING INTO DATABASE_V2
----------------------------------------
Two additive edits, both reversible, when you're ready:
1. A nav button beside IGNITION opening
   https://markmark5.github.io/[REPO]/drift/index.html in a popup.
2. The drift-pill script (as tested in the demo) added before
   </body>, with its fetch URL pointed at the full Pages URL of
   drift-index.json.
Ask Claude for the exact FIND -> PASTE text when the time comes.


IF SOMETHING LOOKS WRONG
------------------------
- Card wall says it can't load the JSON: check drift-index.json is in
  the same drift folder and the JSON is valid (a missing comma is the
  usual culprit — paste it to Claude to check).
- A card opens a 404: the TICKER.html upload was missed or misnamed.
- Changes not showing: wait a minute (Pages rebuild), then hard-refresh
  (Ctrl+Shift+R).
