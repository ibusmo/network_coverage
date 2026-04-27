import json
import os
import threading
from typing import Any, Dict, Optional

from flask import Flask, jsonify, render_template, request

from wifi_environment import (
    merge_survey_summaries,
    run_survey,
    suggest_channels,
    survey_fill_ssids_from_airport,
)

DEFAULT_PORT = 5002
# So `flask run` matches `python app.py` (Flask CLI otherwise defaults to 5000).
os.environ.setdefault('FLASK_RUN_PORT', str(DEFAULT_PORT))

_APP_DIR = os.path.dirname(os.path.abspath(__file__))
_STATE_PATH = os.path.join(_APP_DIR, 'survey_state.json')
_MAX_HISTORY = 80
app = Flask(
    __name__,
    root_path=_APP_DIR,
    static_folder=os.path.join(_APP_DIR, 'static'),
    template_folder=os.path.join(_APP_DIR, 'templates'),
)


@app.after_request
def _no_cache_local(resp):
    """Avoid stale JS/CSS in dev so spectrum & bar strips always match the server."""
    p = request.path or ''
    if p == '/' or p.startswith('/static/'):
        resp.headers['Cache-Control'] = 'no-store, max-age=0'
        resp.headers['Pragma'] = 'no-cache'
    return resp

_lock = threading.Lock()
_state: Dict[str, Any] = {
    'status': 'idle',
    'message': None,
    'last': None,
    'history': [],
}


def _history_meta(item: Dict[str, Any]) -> Dict[str, Any]:
    summary = item.get('summary') or {}
    nets = summary.get('networks') or []
    link = summary.get('link') or {}
    n24 = 0
    n5 = 0
    for r in nets:
        bk = (r.get('band_key') or '').strip()
        ch = r.get('channel')
        if bk == '2.4':
            n24 += 1
        elif bk == '5':
            n5 += 1
        elif not bk:
            try:
                c = int(ch) if ch is not None else None
            except Exception:
                c = None
            if c is not None:
                if 1 <= c <= 14:
                    n24 += 1
                elif c >= 36:
                    n5 += 1
    return {
        'id': item.get('id'),
        'scanned_at': item.get('scanned_at') or summary.get('scanned_at') or '—',
        'network_count': len(nets),
        'connected_ssid': link.get('ssid') or '(hidden)',
        'link_rssi': link.get('rssi'),
        'count_24': n24,
        'count_5': n5,
        'source': summary.get('source') or '',
        'note': summary.get('note') or '',
    }


def _save_state_locked():
    payload = {
        'last': _state.get('last'),
        'history': _state.get('history') or [],
    }
    tmp = f'{_STATE_PATH}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=True)
    os.replace(tmp, _STATE_PATH)


def _load_state_from_disk():
    if not os.path.isfile(_STATE_PATH):
        return
    try:
        with open(_STATE_PATH, 'r', encoding='utf-8') as f:
            payload = json.load(f)
        if isinstance(payload, dict):
            _state['last'] = payload.get('last')
            hist = payload.get('history')
            _state['history'] = hist if isinstance(hist, list) else []
    except Exception:
        # Keep running with in-memory defaults when file is missing/corrupt.
        pass


with _lock:
    _load_state_from_disk()


def _fill_link_from_history(summary: Dict[str, Any], prev: Optional[Dict[str, Any]]) -> None:
    """When current link fields are missing/redacted, fill from previous summary link."""
    if not isinstance(summary, dict):
        return
    link = summary.get('link') or {}
    prev_link = (prev or {}).get('link') or {}
    if not isinstance(link, dict) or not isinstance(prev_link, dict):
        return

    ssid = (link.get('ssid') or '').strip()
    bssid = (link.get('bssid') or '').strip()
    if (not ssid or ssid in ('(hidden)', 'Connected')) and (prev_link.get('ssid') or '').strip():
        link['ssid'] = prev_link.get('ssid')
        link['ssid_from_history'] = True
    if (not bssid) and (prev_link.get('bssid') or '').strip():
        link['bssid'] = prev_link.get('bssid')
        link['bssid_from_history'] = True

    if link.get('rssi') is None and prev_link.get('rssi') is not None:
        link['rssi'] = prev_link.get('rssi')
        link['rssi_from_history'] = True
    if link.get('channel') is None and prev_link.get('channel') is not None:
        link['channel'] = prev_link.get('channel')
    if not (link.get('band') or '').strip() and (prev_link.get('band') or '').strip():
        link['band'] = prev_link.get('band')
    if not (link.get('band_key') or '').strip() and (prev_link.get('band_key') or '').strip():
        link['band_key'] = prev_link.get('band_key')
    summary['link'] = link


def _do_survey(replace: bool = False):
    global _state
    try:
        summary = run_survey(prefer_airport=False)
        prev = None
        with _lock:
            prev = _state.get('last')
        if not replace:
            prev_rows = (prev or {}).get('networks') or []
            if prev_rows:
                summary = merge_survey_summaries(prev, summary)
        summary = survey_fill_ssids_from_airport(summary)
        _fill_link_from_history(summary, prev)
        summary['suggestions'] = suggest_channels(summary)
        with _lock:
            scanned_at = summary.get('scanned_at') or ''
            scan_id = f"{scanned_at}|{len(_state.get('history') or []) + 1}"
            _state['history'] = [
                {
                    'id': scan_id,
                    'scanned_at': scanned_at,
                    'summary': summary,
                },
                *(_state.get('history') or []),
            ][:_MAX_HISTORY]
            _state['status'] = 'idle'
            _state['message'] = None
            _state['last'] = summary
            _save_state_locked()
    except Exception as e:
        with _lock:
            _state['status'] = 'idle'
            _state['message'] = str(e)
            if _state['last'] is None:
                _state['last'] = {
                    'ok': False,
                    'error': str(e),
                    'note': None,
                    'networks': [],
                    'by_channel': {'2.4': {}, '5': {}, '6': {}, 'other': {}},
                    'link': {},
                }
            _save_state_locked()


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/survey', methods=['POST'])
def start_survey():
    replace = request.args.get('replace') == '1'
    with _lock:
        if _state['status'] == 'running':
            return jsonify({'status': 'already_running'}), 409
        _state['status'] = 'running'
        _state['message'] = 'Scanning Wi‑Fi…'
    threading.Thread(target=_do_survey, kwargs={'replace': replace}, daemon=True).start()
    return jsonify({'status': 'running', 'replace': replace})


@app.route('/api/survey/status')
def survey_status():
    with _lock:
        return jsonify({
            'status': _state['status'],
            'message': _state['message'],
        })


@app.route('/api/survey/latest')
def survey_latest():
    with _lock:
        if _state['last'] is None:
            return jsonify({'status': 'empty', 'summary': None})
        return jsonify({'status': 'ok', 'summary': _state['last']})


@app.route('/api/survey/history')
def survey_history():
    with _lock:
        items = _state.get('history') or []
        return jsonify({'status': 'ok', 'items': [_history_meta(x) for x in items]})


@app.route('/api/survey/history/<scan_id>')
def survey_history_one(scan_id: str):
    with _lock:
        for item in _state.get('history') or []:
            if item.get('id') == scan_id:
                return jsonify({'status': 'ok', 'summary': item.get('summary')})
    return jsonify({'status': 'not_found', 'summary': None}), 404


def _dev_reloader_extra_files():
    root = os.path.dirname(os.path.abspath(__file__))
    out = []
    for subdir, exts in (('static', ('.js', '.css')), ('templates', ('.html',))):
        d = os.path.join(root, subdir)
        if not os.path.isdir(d):
            continue
        for dirpath, _, filenames in os.walk(d):
            for fn in filenames:
                if os.path.splitext(fn)[1].lower() in exts:
                    out.append(os.path.join(dirpath, fn))
    # Watcher used to miss backend modules — without this, editing wifi_environment.py
    # required a manual server restart.
    try:
        for name in os.listdir(root):
            path = os.path.join(root, name)
            if name.endswith('.py') and os.path.isfile(path):
                out.append(path)
    except OSError:
        pass
    return out


if __name__ == '__main__':
    port = int(os.environ.get('PORT', str(DEFAULT_PORT)))
    use_reloader = os.environ.get('FLASK_RELOADER', '1').lower() not in ('0', 'false', 'no')
    extra = _dev_reloader_extra_files() if use_reloader else None
    app.run(
        host='127.0.0.1',
        port=port,
        threaded=True,
        use_reloader=use_reloader,
        debug=False,
        extra_files=extra,
    )
