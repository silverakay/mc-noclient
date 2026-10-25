# Fixed 26.2 protocol and item data

`protocol-26.2.json` is the project's existing fixed protocol-776 schema copied
from `docs/protocol-26.2.json`. SHA-256:
`e19d839857e4fc9faaa829e68736eaab181f21167db1b0449d3abb284b47305d`.
It is not an automatically selected upstream default version.

Compilation corrects two player-info definitions against the local official
26.2 bytecode: LIST_ORDER is bit 6, HAT is bit 7, and listed is a boolean.
`tools/official_server_features_check.js` independently checks official packet
registration, player-info fields, item component encoding, suggestions and ACKs.

`items-26.2.json` contains 1537 item IDs, identifiers and translation keys
exported from `BuiltInRegistries.ITEM` in the local official 26.2 server jar.
The jar SHA-256 is
`183c0499c5f855570ee487dd38e141a53f0121f83a0b07a3bac2d8b6698823e8`.
The JSON SHA-256 is
`bd8e7648e0a6752cc393c42404ae291ad73e7b6cfd89bb88917e0073a90427ec`.
Names are translated with the existing offline official zh_cn table.

Reproduce the item export with `node tools/update_item_names.js`. This invokes
only the Java codec helper's `items` mode, in a temporary directory. It never
starts the server, loads accounts, connects, or downloads assets.
