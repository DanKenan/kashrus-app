SHUTFEY · D1 MESSY-CONTENT TEST SET
DRAFT — for Muse + ChatGPT to debate and sign.
For every PR that changes appearance (spec §10): screenshots and visual checks use exactly this data. Dev / emulator only — never seeded into production. Sample people and places, not real. Names are male or neutral (rule U: the wording around them stays gender-neutral).

WHAT THIS SET MUST PROVE (from the signed vision's messy-content test)
1. 100-character task names → the first Receiving task is 103 characters; three others are 107–109.
2. 15+ kiosk tasks → Crown Market has 18 tasks today: 6 done, 1 failed check ("no"), 1 "Needs attention", 2 check-ins in progress, 8 open.
3. Hebrew and mixed-direction text → a fully Hebrew task, two mixed EN/HE tasks with brackets and numbers (the bidi trouble cases), a Hebrew venue name, a Hebrew user name, a Hebrew handoff note, a Hebrew question at the end of the incident.
4. Two-line venue names → "The Grand Ballroom at Congregation Beth Israel's Community Center — Main Kitchen & Bakery" (89 chars) and an 84-char agency name.
5. Several alerts at once → 5 alerts (4 overdue + incidents), one with the long venue name inside it.
6. Empty records → "Empty Test Venue" (nothing at all), a task with empty notes, an empty handoff note, a user with no venue (legacy record).
7. Long incident text → 656 characters, ends in Hebrew.
8. Long person names → "Avraham Yitzchak Rosenzweig-Halberstam" (38 chars), "Yossi Abramowitz-Goldberger"; two people both called Moshe.
9. Devices and settings, each screenshot run: 390×844 phone, 1024×768 tablet, 1180×820 kiosk, 1440×900 desk; day and night; browser text at 200 % (or iOS largest text); prefers-reduced-motion on.

PASS RULES (proposed)
- No text overflows its box or overlaps another; long text truncates with an ellipsis or wraps to at most two lines on rows (then tap for details).
- Hebrew reads right-to-left inside its own run; numbers, brackets and "#4471" stay in the right place in the mixed rows.
- Done rows show the small seal + name + time; never a fully gold card. The "no" and "Needs attention" rows are not gold.
- The two Moshes are distinguishable on the kiosk (full name or initial).
- The empty venue shows a calm empty state, not a blank screen or an error.
- The 15+ list scrolls on the kiosk without hiding the main action.

THE DATA (copy into tests/fixtures/messy-content.json; Muse adapts field names to the real seed format — fields follow src/types.ts on main 8c7093c)

{
  "_note": "DRAFT — for Muse + ChatGPT to debate and sign. Messy-content test set for Shutfey (D1). Dev/emulator only, never production. Sample people and places; not real.",
  "agencies": [
    {
      "id": "agency-hkc",
      "name": "Hartford Kashrut Commission (HKC)",
      "shortCode": "HKC"
    },
    {
      "id": "agency-long",
      "name": "Vaad HaKashrus of Greater Northern New Jersey, Rockland County and the Hudson Valley",
      "shortCode": "VHNJRCHV"
    }
  ],
  "venues": [
    {
      "id": "v-crown",
      "agencyId": "agency-hkc",
      "name": "Crown Market",
      "category": "Supermarket"
    },
    {
      "id": "v-long",
      "agencyId": "agency-hkc",
      "name": "The Grand Ballroom at Congregation Beth Israel's Community Center — Main Kitchen & Bakery",
      "category": "Catering hall"
    },
    {
      "id": "v-heb",
      "agencyId": "agency-long",
      "name": "מאפיית שמעון ובניו — Shimon & Sons Bakery",
      "category": "Bakery / factory"
    },
    {
      "id": "v-empty",
      "agencyId": "agency-long",
      "name": "Empty Test Venue",
      "category": "Restaurant"
    }
  ],
  "users": [
    {
      "name": "Eli",
      "role": "coordinator",
      "venueId": "v-crown"
    },
    {
      "name": "Yossi Abramowitz-Goldberger",
      "role": "mashgiach",
      "venueId": "v-crown",
      "pinEnabled": true
    },
    {
      "name": "Moshe Friedman",
      "role": "mashgiach",
      "venueId": "v-crown",
      "pinEnabled": true
    },
    {
      "name": "Avraham Yitzchak Rosenzweig-Halberstam",
      "role": "mashgiach",
      "venueId": "v-long",
      "pinEnabled": true
    },
    {
      "name": "Eli Ben-Shimon",
      "role": "mashgiach",
      "venueId": "v-crown",
      "pinEnabled": true
    },
    {
      "name": "Dovid Shapiro",
      "role": "worker",
      "venueId": "v-crown"
    },
    {
      "name": "Shmuel Katz",
      "role": "mashgiach",
      "venueId": "v-crown",
      "pinEnabled": true
    },
    {
      "name": "יוסף חיים",
      "role": "mashgiach",
      "venueId": "v-heb",
      "pinEnabled": true
    },
    {
      "name": "Moshe",
      "role": "mashgiach",
      "venueId": "v-crown",
      "pinEnabled": true,
      "_why": "same first name as Moshe Friedman: the kiosk must tell them apart"
    },
    {
      "name": "Admin (HKC)",
      "role": "admin",
      "venueId": null
    },
    {
      "name": "Legacy User",
      "role": "worker",
      "venueId": null,
      "_why": "legacy record: old role name, no venue"
    }
  ],
  "tasks_crown_market": [
    {
      "title": "Light the pilot lights (bishul Yisrael)",
      "category": "Bishul",
      "inputType": "toggle",
      "currentStatus": "completed",
      "isCompleted": true,
      "updatedByName": "Moshe Friedman",
      "updatedAt": "06:42",
      "notes": ""
    },
    {
      "title": "Open the walk-in and check temperatures",
      "category": "Opening",
      "inputType": "checkbox",
      "currentStatus": "completed",
      "isCompleted": true,
      "updatedByName": "Yossi Abramowitz-Goldberger",
      "updatedAt": "06:55",
      "notes": ""
    },
    {
      "title": "Check the hechsher, batch number and expiry on every incoming case of spices before it reaches the line",
      "category": "Receiving",
      "inputType": "yes_no",
      "currentStatus": "yes",
      "isCompleted": true,
      "updatedByName": "Eli Ben-Shimon",
      "updatedAt": "07:10",
      "notes": ""
    },
    {
      "title": "Check eggs for blood spots — every egg, every batch, including the liquid-egg cartons used by the bakery team",
      "category": "Produce",
      "inputType": "check_in",
      "currentStatus": "in_progress",
      "isCompleted": false,
      "updatedByName": null,
      "updatedAt": null,
      "notes": ""
    },
    {
      "title": "בדיקת ירקות עליים — חסה, פטרוזיליה וכוסברה",
      "category": "Produce",
      "inputType": "checkbox",
      "currentStatus": "pending",
      "isCompleted": false,
      "updatedByName": null,
      "updatedAt": null,
      "notes": ""
    },
    {
      "title": "Inspect lettuce / בדיקת חסה (light box, 3 leaves per head)",
      "category": "Produce",
      "inputType": "checkbox",
      "currentStatus": "pending",
      "isCompleted": false,
      "updatedByName": null,
      "updatedAt": null,
      "notes": ""
    },
    {
      "title": "Verify meat delivery seals from Agri-Star #4471 and the second supplier (Kehilla Glatt Wholesale, Brooklyn)",
      "category": "Receiving",
      "inputType": "status_select",
      "currentStatus": "Seals intact",
      "isCompleted": true,
      "updatedByName": "Avraham Yitzchak Rosenzweig-Halberstam",
      "updatedAt": "08:03",
      "notes": "Two cases had torn tape; checked and resealed with the venue's tag 0091–0094."
    },
    {
      "title": "Kasher the new sheet pans (libun)",
      "category": "Kashering",
      "inputType": "toggle",
      "currentStatus": "pending",
      "isCompleted": false,
      "updatedByName": null,
      "updatedAt": null,
      "notes": ""
    },
    {
      "title": "Dairy equipment stays in the blue zone",
      "category": "Separation",
      "inputType": "yes_no",
      "currentStatus": "no",
      "isCompleted": false,
      "updatedByName": "Dovid Shapiro",
      "updatedAt": "09:15",
      "notes": "Blue cutting board found on the meat side. Moved back; told the line cook."
    },
    {
      "title": "Wine: confirm mevushal labels on every open bottle at the bar",
      "category": "Bar",
      "inputType": "yes_no",
      "currentStatus": "pending",
      "isCompleted": false,
      "updatedByName": null,
      "updatedAt": null,
      "notes": ""
    },
    {
      "title": "Pas Yisroel: turn on the bakery oven",
      "category": "Bakery",
      "inputType": "toggle",
      "currentStatus": "completed",
      "isCompleted": true,
      "updatedByName": "Moshe Friedman",
      "updatedAt": "05:58",
      "notes": ""
    },
    {
      "title": "Check-in",
      "category": "Shift",
      "inputType": "check_in",
      "currentStatus": "in_progress",
      "isCompleted": false,
      "updatedByName": null,
      "updatedAt": null,
      "notes": ""
    },
    {
      "title": "Fish: check scales on every whole fish (salmon, branzino, trout) and keep one fillet with skin for each batch",
      "category": "Receiving",
      "inputType": "checkbox",
      "currentStatus": "pending",
      "isCompleted": false,
      "updatedByName": null,
      "updatedAt": null,
      "notes": ""
    },
    {
      "title": "Close the walk-in and lock the meat cage",
      "category": "Closing",
      "inputType": "toggle",
      "currentStatus": "pending",
      "isCompleted": false,
      "updatedByName": null,
      "updatedAt": null,
      "notes": ""
    },
    {
      "title": "Sign the end-of-shift log",
      "category": "Closing",
      "inputType": "checkbox",
      "currentStatus": "pending",
      "isCompleted": false,
      "updatedByName": null,
      "updatedAt": null,
      "notes": ""
    },
    {
      "title": "Spices",
      "category": "Receiving",
      "inputType": "checkbox",
      "currentStatus": "pending",
      "isCompleted": false,
      "updatedByName": null,
      "updatedAt": null,
      "notes": ""
    },
    {
      "title": "Clean the rotisserie ‎(Kosher-for-Pesach line)‎ — מטבח פסח",
      "category": "Kashering",
      "inputType": "status_select",
      "currentStatus": "Needs attention",
      "isCompleted": false,
      "updatedByName": "Shmuel Katz",
      "updatedAt": "10:40",
      "notes": ""
    },
    {
      "title": "Coffee machine: ‏חלב ישראל‏ milk only (Cholov Yisroel)",
      "category": "Bar",
      "inputType": "yes_no",
      "currentStatus": "yes",
      "isCompleted": true,
      "updatedByName": "Eli Ben-Shimon",
      "updatedAt": "11:02",
      "notes": ""
    }
  ],
  "tasks_crown_market_count": 18,
  "alerts": [
    "Overdue: Check eggs for blood spots (due 7:30 AM)",
    "Overdue: בדיקת ירקות עליים (due 8:00 AM)",
    "Incident open: Blue cutting board on the meat side",
    "Overdue: Wine mevushal labels (due 11:00 AM)",
    "Incident open at The Grand Ballroom at Congregation Beth Israel's Community Center — Main Kitchen & Bakery: non-certified chocolate chips found in dry storage"
  ],
  "incident_long_text": "At about 9:15 AM Dovid Shapiro found a blue (dairy) cutting board on the meat prep table next to the grill station. It had been used to slice raw onions, which then went into the brisket marinade for the 6:00 PM event. The board was removed, the onions and the marinade were set aside and labelled 'DO NOT USE — waiting for the Rav', and the line cook was shown the colour chart again. Photos attached. The Rav was called at 9:24 AM and asked to decide whether the marinade and the two sheet pans it touched need kashering. Waiting for an answer; the event menu may need the backup brisket from Crown Market's freezer. שאלה לרב: האם צריך להכשיר את התבניות?",
  "handoff_notes": [
    "Night shift: the walk-in door sticks — push hard and check it closed. Moshe",
    "הספק החדש מגיע ביום רביעי בבוקר, לבדוק חותמות",
    ""
  ],
  "events": [
    {
      "title": "Rosenzweig–Halberstam Wedding (Sheva Brachos dinner, 340 guests, two menus: meat main hall + dairy dessert room)",
      "venue": "v-long",
      "date": "2026-10-25",
      "startTime": "17:00",
      "endTime": "23:30",
      "mashgiach": "Avraham Yitzchak Rosenzweig-Halberstam"
    },
    {
      "title": "Bar Mitzvah kiddush",
      "venue": "v-crown",
      "date": "2026-10-24",
      "mashgiachType": "unassigned"
    }
  ],
  "empty_records": {
    "venue": "v-empty (no tasks, no history, no incidents, no events, no staff)",
    "task_with_empty_notes": "Spices",
    "user_with_no_venue": "Legacy User"
  }
}
