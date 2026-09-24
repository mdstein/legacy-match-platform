# Native Trading tab

Operate mode for B2G players exchanging owned cosmetics. Follow the existing
native launcher design and the requested Steam-style offer model. This is a
local extension with a specified interaction reference, so it uses a code-led
implementation without a new visual identity or concept selection round.

Keep the header and Play/session footer. Add a Trading tab with incoming count.
Its compact left column contains New Offer, Incoming, Outgoing, History and the
player's share code. The main area shows actionable offers, then an exact
two-sided review. The composer pairs searchable inventories under You give and
You receive; selection remains legible through text, focus and restrained blue.
Real item art, condition, rarity and inspection provide evidence for decisions.

Sending approves the shown terms; the recipient may accept while the sender is
offline. Countering creates a new revision. Any changed item invalidates review.
Gifts require explicit confirmation. StatTrak reset is explained in item review.
Finish loading, empty, unpaired, offline, disabled, expired and error states;
persist ambiguous requests for exact retry. Receiving an offer never takes focus
from gameplay. Keep network/image I/O off the UI thread and cap caches/workers.

The memorable interaction is selecting a real item into an unambiguous give or
receive side, followed by a final comparison showing the exact exchange.
Preserve native buttons, edits, keyboard navigation and window controls.
Validate the supported size/DPI matrix with the shared native painter, then
controlled HWND interactions and independent finish review. No synthetic
fixture represents a real player's inventory or an actual public exchange.

No unresolved product choices. The game and site's deployed version remains
0.2.28 until the coordinated release is verified.
