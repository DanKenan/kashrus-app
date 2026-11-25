# Company items and certificates

These Chromium captures use the Company screen and authenticated Shutfey routes with a synthetic Ahlstrom fixture. The fixture runs separate loopback servers for Airtable records and direct attachment uploads. Each of the 29 ingredients has its own attachment ID. The product list contains 26 rows.

| Flow | Screenshots |
| --- | --- |
| Company details, LOC, lists, fees, location and removal | [Full Company screen](01-company.png) |
| Populated and missing certification with a PDF | [Ingredients](02-ingredients.png) |
| Status, symbol, UPC, missing agency and Edit | [Products](03-products.png) |
| Direct PDF replacement | [File selected](04-replace-selected.png) · [Replacement confirmed](04-replace-confirmed.png) |
| Lost upload response with two matching new IDs | [Manual review](04-upload-review.png) |
| Assigned coordinator | [Company LOC](05-coordinator-company.png) · [Ingredient certificates at 430 px](05-coordinator-ingredient.png) |
| Failed source refresh | [Company and last-read time](06-offline.png) · [Cached ingredient list](06-offline-ingredients.png) |
| Narrow screens | [320 px](mobile-320.png) · [390 px](mobile-390.png) |

The browser checks opened a synthetic PDF, submitted a binary replacement, and exercised recovery after the upload response was lost. At 320, 390, and 430 pixels they checked keyboard focus, 44 px document controls, and horizontal overflow with an unbroken filename longer than 130 characters.

Airtable accepts attachment-list updates through ordinary PATCH requests. Shutfey checks the IDs immediately before cleanup and serializes its own writes. An external Airtable writer can still change the list between that last read and the PATCH.
