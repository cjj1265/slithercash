# Demo mode: show the game off with bots and play money

This runs the game **on your own computer**, with no wallet and no real money, so you can record gameplay.
Nothing you do here touches the live game, the chain or anyone's balance.

## Run it

From the `files` folder:

```
npm run demo
```

Then open **http://localhost:8787** (or the port shown in the window).

## What you can change on the main screen

- **Add funds:** any amount of play money (or the +100 / +1K / +10K / +1M buttons). A buy-in comes out of this
  balance and a cash-out goes back in, like the real game.
- **Bots:** how many (0 to 80), and **Bot size** (Normal, Big, Huge). Press **Apply bots** to replace them.
- **Arena:** Small, Medium or Full size. A new size starts at your next game.
- **Skins:** every skin is unlocked.
- **Show the DEMO badge:** the small "DEMO · play money" label. Leave it on for anything you post, so nobody
  mistakes the footage for real money play.

Everything else (spawn protection, the cash-out hold, sounds, the cash-out card) works like the real game. The
demo adds free food that keeps appearing, so the map stays busy.

## Safety

- It only answers to **this computer**, not to other devices on your network.
- It **refuses to start** if a wallet is set up (`GAME_WALLET_SECRET`), on a host like Render, or on mainnet.
- Never set `DEMO_MODE` on the live service.