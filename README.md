# dryerSensor

Arduino firmware for the Seeed XIAO nRF52840 Sense (BMP585 over BLE) plus Python tools for the PC side.

## Python setup (one time per teammate)

Python libraries are managed with [uv](https://docs.astral.sh/uv/). You do **not** need to install Python or any library by hand.

1. Install uv:
   - Windows (PowerShell): `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
   - macOS / Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`
2. Clone the repo and install everything from the lockfile:
   ```
   git clone https://github.com/JKing4965/dryerSensor.git
   cd dryerSensor
   uv sync
   ```
   uv downloads Python 3.13 (from `.python-version`) and the exact library versions in `uv.lock` into a local `.venv/`.

## Running scripts

```
uv run ble_reader.py --scan
uv run ble_reader.py --name XIAO-BLE --text
```

`uv run` always uses the project environment, so there is no need to activate `.venv`. In VS Code, pick `.venv` as the Python interpreter.

## Adding or updating a library

```
uv add <package>        # e.g. uv add numpy
uv remove <package>
uv lock --upgrade       # bump everything to the newest allowed versions
```

Always commit **both** `pyproject.toml` and `uv.lock`. Teammates then run `uv sync` after pulling to get the same libraries. Never commit `.venv/`.

## Git workflow

1. `git pull` on `main`, then `git switch -c <your-branch>`.
2. Commit your changes and `git push -u origin <your-branch>`.
3. Open a pull request into `main` on GitHub; a teammate reviews and merges.
4. After a merge, everyone runs `git pull` and `uv sync`.
