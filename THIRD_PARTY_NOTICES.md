Kelivo world books
=================

The world-book model, activation rules and injection behavior in
`src/world-book.js` are ported from Chevey339/kelivo, revision
86de75b75c66f2c9b9de4299069068bd18f53766:
https://github.com/Chevey339/kelivo

Upstream is licensed under GNU Affero General Public License version 3.
The license is included in `LICENSES/Kelivo-AGPL-3.0.txt`. The combined backend
including this adaptation is provided under AGPL-3.0. Its corresponding source
is available at https://github.com/cai5232/lumi-server.
Port and integration changes: 2026-10-03.

Murmur native REST integration
==============================

Lumi now communicates over HTTP with the independent Murmur engine:
https://github.com/cai5232/murmur

The engine's LICENSE is Creative Commons Attribution-NonCommercial-ShareAlike
4.0 International. Copyright (c) 2026 fishisfish0614 (Fish 小鱼) and Keyan (克衍).
The engine and its deployment modifications remain in their separate repository
with their original LICENSE and attribution. The old Murmur-50Feet-derived
src/emotion.js implementation has been removed from this version of Lumi.
The new client transports native emotion deltas and reads native state; the
Python engine exclusively owns its dynamics and persistence.

Promise Alarm
=============

The complete Promise Alarm application is included in `promise-alarm/` from
https://github.com/cai5232/promise-alarm. Its upstream license file carries
the required notice `Copyright Monagwd (https://github.com/Monagwd)` and the
PolyForm Noncommercial License 1.0.0. The license text is preserved at
`promise-alarm/LICENSE` and applies to that directory. Lumi integration and
deployment wiring are in `src/promise-alarm.js` and `src/index.js`.
