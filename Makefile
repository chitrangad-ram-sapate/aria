# ARIA build targets. On Windows without make, use scripts/run.ps1 for `run`.
PY ?= $(if $(wildcard .venv/python.exe),.venv/python.exe,$(if $(wildcard .venv/bin/python),.venv/bin/python,python))
NETWORK ?= kolhapur

.PHONY: install data forecast replay test run docker

install:
	$(PY) -m pip install -r requirements.txt

data:
	$(PY) -m aria.data.build

forecast:
	$(PY) -m aria.data.build --refit

replay:
	$(PY) -m aria.replay.run --network $(NETWORK)

test:
	$(PY) -m pytest -q

run:
	$(PY) -m uvicorn api.main:app --host 127.0.0.1 --port 8000 & \
	$(PY) -m streamlit run ui/app.py --server.address 127.0.0.1 --server.port 8501 --browser.gatherUsageStats false

docker:
	docker compose up --build
