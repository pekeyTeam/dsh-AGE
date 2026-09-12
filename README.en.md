# dsh-AGE

**The "anti-cheat security component is scanning" stutter, reproduced inside dsh.**

The pointer that suddenly drags. The AI reply that stops mid-sentence and then dumps everything at once. The settings dialog that takes a beat too long. dsh-AGE puts those seconds — the ones anyone who plays games knows best — into dsh's web interface, driven by one simulated scan scheduler, so you can enjoy the same care and attention while you use dsh.

![AGE](assets/age.jpg)

---

## Disclaimer

dsh-AGE is a **pointless plugin** that simulates the "security component scanning" stutter inside dsh's web interface.

- It is **affiliated with xxx in no way whatsoever**, and is neither authorised nor endorsed by them. "AGE" is its own name.
- It does **not** read, upload, or modify any account data, conversations, or local files. Every stall is produced locally in your browser, disappears on refresh, and leaves nothing behind when uninstalled.
- It **deliberately burns main-thread CPU** (about 15 seconds per minute on the default preset). On a low-end machine that is noticeably more heat, more fan noise and less battery.
- This is not anti-virus. **Press `Ctrl+Alt+Shift+A` to stop it at any time.**

---

## Install

```sh
dsh plugin --profile web add github:<owner>/dsh-age
```

Restart dsh afterwards. To pin a version:

```sh
dsh plugin --profile web add github:<owner>/dsh-age#<commit-sha>
```

Remove it with:

```sh
dsh plugin --profile web remove dsh-age
```

---

## The three symptoms

On the default (`heavy`) preset: **a scan every 5–15 seconds, 1–3 seconds each.**

| Symptom | What you see |
|---|---|
| **Pointer stall** | The **pointer itself** stops. Your hand moves, the pointer stays frozen where it was, and a few seconds later it appears at your current position |
| **Text stalls** | Three shapes of one symptom: the reply stops and later dumps its backlog at once; it arrives in lumps instead of flowing; or it gets pulled sideways and snaps back. Nothing is lost, only delayed |
| **Interaction stalls** | Dialogs and menus arriving during a scan fade in late; switching conversations stutters |

---

## Presets

Stutter does not arrive evenly spread — it comes in **bursts**: a run of hitches, a calm stretch, another run. That is the rhythm of a real kernel scan.

| Preset | Per hitch | Cadence | Blocked per minute |
|---|---|---|---|
| Light | 0.2–0.5s | ~20 in a row, then 30–60s calm | ~6s (10%) |
| Medium | 0.4–1s | ~20 in a row, then 15–35s calm | ~10s (17%) |
| **Heavy (default)** | **1–3s** | **4–10 in a row, then 5–15s calm** | **~15s (25%)** |
| Hell | 1.5–2.5s | 10–24 in a row, barely any calm | ~24s (40%) |

---
