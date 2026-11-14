"""
dryer_backend - Python package for the dryer lint sensor backend.

What it does:
    Receives text messages from the XIAO nRF52840 board over Bluetooth (or from
    the simulator / a replay file), parses them, stores readings and cycles in
    TimescaleDB, and computes per-cycle lint metrics.

Modules (added step by step, see docs/build_plan.md):
    config.py     settings from the repo-root .env file
    protocol.py   line reassembly + message parsing (format in docs/protocol.md)
    sources.py    where lines come from: BLE, simulator, replay file
    ble_link.py   Bluetooth connection to the board
    timesync.py   board milliseconds -> real timestamps
    db.py         database access
    cycles.py     cycle open/close + duplicate handling
    features.py   per-cycle numbers used for lint status
    simulator.py  fake board for testing without hardware
    ingest.py     entry point that wires everything together

How to run:
    cd backend
    uv run python -m dryer_backend.ingest --help    (available from step B3)
"""
