# Lector de libros / Book reader

A Kino plugin that reads DRM-free `.mobi` and `.epub` books inside Kino. It is also the reference example of a plugin built on
Kino's screen components: read its source (`plugin.js`) to see how each piece is done.

## What it does

- **Find books:** Project Gutenberg's whole catalogue (search by title or author, filter by language, "more books"), and
  archive.org (EPUB and Kindle files that are free to download).
- **Read:** pages that follow the text size (A− / A+), a slider, swipe to turn the page (Kino 0.9.82 and later), covers.
- **Contents:** chapters from the book's headings, search inside the book, bookmarks, and a note on any page.
- **My library:** every book you open stays, on the page you left it. Favourites, categories (up to six), filters, progress.
  Only the downloaded text is dropped when space runs short; notes, bookmarks and the place stay.
- **Big books:** an EPUB over 3 MB is read by parts (only its text, no pictures), a Kindle file is cut before its pictures, and
  opening a book is done in short steps with a progress notice, so a slow phone never runs out of time.

Hosts: `www.gutenberg.org`, `gutendex.com`, `archive.org` and `*.archive.org`. Nothing else is contacted.

## How it is built (for plugin authors)

| Piece | Where in `plugin.js` | Kino feature it shows |
| --- | --- | --- |
| Tabs in the app bar, close and back | `library`, `contents` | `Scaffold`, `AppBar` with `mergeWithKinoBar`, `TabBar`, `onBack` |
| Lists with covers | `tile`, `cover` | `ListTile`, `Image` with a `fallback`, `data:` covers |
| Loading veil with no wait | `BUSY`, `skeleton` | `ui` operations on a press, `Skeleton` |
| Page turn, slider, text size | `reader` | `Slider`, `IconButton`, `onSwipeLeft` / `onSwipeRight` |
| Book menu, category menu | `bookMenu`, `catMenu` | the `menu` answer |
| Note box | `noteScreen` | multiline `TextField` |
| Filters | `mineTab` | `Chips` |
| Work that outlasts one call | `prepare`, `downloadPieces`, `downloadEpubParts` | `every` timer, resumable steps, `Range` requests |
| A library that outgrows 16 MB | `touchLibrary`, `writeParas` | `storageLarge`, values of at most 2 MB, an eviction rule |

Tests that run in Node live next to the Kit: `node sdk/validate.mjs plugins/lector-mobi`.

Plugin API 19 (Kino 0.9.81 or later); swipe and the cover pictures held in the book arrive with Kino 0.9.82.
