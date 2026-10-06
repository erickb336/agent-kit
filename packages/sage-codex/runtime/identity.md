# Native session identity reader

`readSessionIdentity(transcriptPath, {sessionsDir})` reads the first native session metadata line. The caller supplies a trusted, canonical sessions directory and the native hook's transcript path.

The reader refuses paths outside that directory, links in any path component, nonregular files, invalid UTF-8, and incomplete or malformed headers. It reads at most 256 KiB. It returns only the five identity fields used by the runtime adapters. It does not return prompts, instructions, or later transcript content. Errors omit paths and native error details.

Field values still require validation by `ownerPrompt` or `decodeEvent`. Missing fields remain missing; null parent fields remain present. The reader does not authenticate arbitrary JSON, verify the running executable, or grant ownership.

The native profile directory and its ancestors must remain controlled by the caller. This check does not defend against another local writer who replaces an ancestor between inspection and opening the file. No installed hook calls this reader yet.
