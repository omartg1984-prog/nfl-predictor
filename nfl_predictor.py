#!/usr/bin/env python3
"""
NFL Predictor
-------------
Descarga resultados y estadisticas de la NFL (API publica de ESPN), calcula
estadisticas por equipo y genera predicciones jornada por jornada.

Cada jornada W se predice usando SOLO los partidos jugados antes de W, asi se
puede ver como "se hubiera visto" la prediccion en su momento y medir aciertos.

Uso:  python nfl_predictor.py          (actualiza todo y regenera data/nfl_data.js)
"""
import json
import math
import os
import sys
import time
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from statistics import NormalDist, pstdev

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE, "data")
CACHE_DIR = os.path.join(DATA_DIR, "cache")
OUT_FILE = os.path.join(DATA_DIR, "nfl_data.js")
LOG_FILE = os.path.join(DATA_DIR, "actualizacion.log")
API = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"

# ---- Parametros del modelo ----
HFA_POINTS = 1.8        # ventaja de local en puntos (NFL moderna ~1.5-2)
SIGMA = 13.5            # desviacion estandar del margen final en la NFL
PRIOR_GAMES = 2.0       # "partidos fantasma" de promedio de liga (evita extremos con pocas jornadas)
DEFAULT_PLAYS = 62.0    # jugadas ofensivas promedio por partido (si falta el dato)
DEFAULT_PPP = 0.355     # puntos por jugada promedio de liga (si aun no hay datos)
PYTH_EXP = 2.37         # exponente pitagorico para la NFL
ELO_K = 20
ELO_HFA = 48            # ventaja de local en puntos Elo
ELO_REVERT = 1 / 3      # regresion a la media entre temporadas
ELO_PTS = 25            # 25 puntos Elo = 1 punto de margen
BASE_WEIGHTS = {"ppp": 0.25, "srs": 0.30, "elo": 0.30, "pyth": 0.15}
POST_LABELS = {1: "Wild Card", 2: "Divisional", 3: "Final de Conferencia", 5: "Super Bowl"}
PHI = NormalDist().cdf
try:   # hora del centro de Mexico (en GitHub Actions el servidor esta en UTC)
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("America/Mexico_City")
except Exception:
    TZ = None


def log(msg):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line)
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def get_json(url, retries=4):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (NFL-Predictor)"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception:
            if i == retries - 1:
                raise
            time.sleep(2 * (i + 1))


def load_json(path, default=None):
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return default


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def to_int(v):
    try:
        return int(str(v).split("-")[0]) if v not in (None, "") else None
    except ValueError:
        return None


# ---------------------------------------------------------------- descarga ---

def week_key(stype, week):
    return week if stype == 2 else 18 + week


def week_label(stype, week):
    return f"Semana {week}" if stype == 2 else POST_LABELS.get(week, f"Playoffs {week}")


def parse_spread(details, home, away):
    """Convierte 'DEN -3.5' en margen esperado del local (+3.5)."""
    if not details:
        return None
    d = details.strip().upper()
    if d.startswith("EVEN") or d in ("PK", "PICK"):
        return 0.0
    parts = d.split()
    try:
        line = float(parts[-1])
    except ValueError:
        return None
    if parts[0] == home:
        return -line
    if parts[0] == away:
        return line
    return None


def parse_event(e, season, stype, week):
    comp = e["competitions"][0]
    cs = comp.get("competitors", [])
    if len(cs) != 2:
        return None
    home = next((c for c in cs if c["homeAway"] == "home"), None)
    away = next((c for c in cs if c["homeAway"] == "away"), None)
    if not home or not away or home["team"]["abbreviation"] in ("AFC", "NFC"):
        return None
    st = comp.get("status", e.get("status", {}))["type"]
    final = bool(st.get("completed"))

    def team(c):
        t = c["team"]
        rec = (c.get("records") or [{}])[0].get("summary")
        return {"abbr": t["abbreviation"], "name": t.get("displayName"), "short": t.get("shortDisplayName"),
                "color": t.get("color"), "alt": t.get("alternateColor"), "logo": t.get("logo"), "record": rec}

    odds = (comp.get("odds") or [{}])[0]
    h, a = team(home), team(away)
    bc = [n for b in comp.get("broadcasts", []) for n in b.get("names", [])]
    return {
        "id": e["id"], "date": e["date"], "season": season, "stype": stype, "week": week,
        "key": week_key(stype, week), "neutral": bool(comp.get("neutralSite")),
        "indoor": bool((comp.get("venue") or {}).get("indoor")),
        "home": h, "away": a, "final": final, "state": st.get("state"), "detail": st.get("shortDetail"),
        "hs": to_int(home.get("score")) if final else None, "as": to_int(away.get("score")) if final else None,
        "venue": (comp.get("venue") or {}).get("fullName"), "tv": ", ".join(bc) or None,
        "odds": odds.get("details"), "ou": odds.get("overUnder"),
        "vegas_margin": parse_spread(odds.get("details"), h["abbr"], a["abbr"]),
    }


def fetch_week(season, stype, week):
    path = os.path.join(CACHE_DIR, f"sb_{season}_{stype}_{week}.json")
    cached = load_json(path)
    if cached is not None:
        return cached
    d = get_json(f"{API}/scoreboard?dates={season}&seasontype={stype}&week={week}")
    games = [g for g in (parse_event(e, season, stype, week) for e in d.get("events", [])) if g]
    if games and all(g["final"] for g in games):
        save_json(path, games)   # jornada terminada: ya no cambia, se guarda
    return games


def fetch_season(season, include_post):
    weeks = [(2, w) for w in range(1, 19)]
    if include_post:
        weeks += [(3, w) for w in POST_LABELS]
    with ThreadPoolExecutor(6) as ex:
        res = list(ex.map(lambda sw: fetch_week(season, *sw), weeks))
    return [g for games in res for g in games]


def fetch_boxscores(season, games):
    """Jugadas ofensivas, yardas y perdidas de balon de cada partido terminado."""
    path = os.path.join(CACHE_DIR, f"box_{season}.json")
    box = load_json(path, {})
    need = [g for g in games if g["final"] and g["id"] not in box]
    if not need:
        return box

    def one(g):
        try:
            d = get_json(f"{API}/summary?event={g['id']}")
        except Exception as ex:
            log(f"  aviso: no se pudo leer boxscore {g['id']}: {ex}")
            return g["id"], None
        out = {}
        for t in d.get("boxscore", {}).get("teams", []):
            st = {}
            for s in t.get("statistics", []):
                st.setdefault(s["name"], s.get("displayValue"))
            out[t["team"]["abbreviation"]] = {
                "plays": to_int(st.get("totalOffensivePlays")), "yards": to_int(st.get("totalYards")),
                "to": to_int(st.get("turnovers")),
            }
        return g["id"], out if len(out) == 2 else None

    log(f"  descargando {len(need)} boxscores de {season}...")
    with ThreadPoolExecutor(8) as ex:
        for gid, out in ex.map(one, need):
            if out:
                box[gid] = out
    save_json(path, box)
    return box


def fetch_extras(season, games):
    """Lesiones, QB titular, clima y pronostico ESPN de los partidos por jugarse.
    Se guarda la ultima version antes del partido; despues del partido ya no se toca."""
    path = os.path.join(CACHE_DIR, f"extras_{season}.json")
    extras = load_json(path, {})
    todo = [g for g in games if not g["final"] and g["state"] == "pre"]
    if not todo:
        return extras

    def one(g):
        try:
            d = get_json(f"{API}/summary?event={g['id']}")
        except Exception as ex:
            log(f"  aviso: no se pudo leer info de {g['id']}: {ex}")
            return g["id"], None
        qb = {}
        for t in d.get("leaders", []):
            for c in t.get("leaders", []):
                if c.get("name") == "passingYards" and c.get("leaders"):
                    qb[t["team"]["abbreviation"]] = c["leaders"][0]["athlete"].get("displayName")
        inj = {}
        for t in d.get("injuries", []):
            lst = []
            for i in t.get("injuries", []):
                status = i.get("status")
                if status in ("Out", "Doubtful", "Questionable"):
                    a = i.get("athlete", {})
                    lst.append({"name": a.get("displayName"), "pos": (a.get("position") or {}).get("abbreviation"),
                                "status": status})
            inj[t["team"]["abbreviation"]] = lst
        w = (d.get("gameInfo") or {}).get("weather") or {}
        pr = d.get("predictor") or {}

        def proj(side):
            try:
                return float(pr[side]["gameProjection"])
            except (KeyError, TypeError, ValueError):
                return None
        return g["id"], {
            "qb": qb, "injuries": inj,
            "weather": {"temp": w.get("temperature"), "gust": w.get("gust"), "precip": w.get("precipitation")} if w else None,
            "fpi_home": proj("homeTeam"), "fpi_away": proj("awayTeam"),
            "fetched": datetime.now().astimezone().isoformat(timespec="minutes"),
        }

    log(f"  descargando lesiones/clima de {len(todo)} partidos...")
    with ThreadPoolExecutor(8) as ex:
        for gid, out in ex.map(one, todo):
            if out:
                extras[gid] = out
    save_json(path, extras)
    return extras


QB_PENALTY = {"Out": 5.0, "Doubtful": 3.5, "Questionable": 1.0}


def auto_adjust(g, ex):
    """Ajuste automatico en puntos para cada equipo por QB titular lesionado y clima."""
    adj = {"home": 0.0, "away": 0.0, "notes": []}
    if not ex:
        return adj
    for side in ("home", "away"):
        abbr = g[side]["abbr"]
        starter = (ex.get("qb") or {}).get(abbr)
        for p in (ex.get("injuries") or {}).get(abbr, []):
            if p["pos"] == "QB" and p["name"] == starter and p["status"] in QB_PENALTY:
                pen = QB_PENALTY[p["status"]]
                adj[side] -= pen
                st = {"Out": "FUERA", "Doubtful": "dudoso", "Questionable": "en duda"}[p["status"]]
                adj["notes"].append(f"QB titular {p['name']} ({abbr}) {st}: -{pen:g} pts a {abbr}")
    w = ex.get("weather")
    if w and not g.get("indoor"):
        per = 0.0
        gust, precip, temp = w.get("gust") or 0, w.get("precip") or 0, w.get("temp")
        if gust >= 25:
            per += 2.0
            adj["notes"].append(f"Viento muy fuerte ({round(gust * 1.609)} km/h): -4 al total")
        elif gust >= 18:
            per += 1.0
            adj["notes"].append(f"Viento fuerte ({round(gust * 1.609)} km/h): -2 al total")
        if precip >= 70:
            per += 1.0
            adj["notes"].append(f"Lluvia/nieve probable ({precip}%): -2 al total")
        elif precip >= 40:
            per += 0.5
            adj["notes"].append(f"Posible lluvia ({precip}%): -1 al total")
        if temp is not None and temp <= 20:
            per += 0.75
            adj["notes"].append(f"Frio extremo ({round((temp - 32) / 1.8)}°C): -1.5 al total")
        adj["home"] -= per
        adj["away"] -= per
    return adj


# ---------------------------------------------------------- estadisticas ---

def team_stats(games, box):
    raw = defaultdict(lambda: dict(g=0, w=0, l=0, t=0, pf=0, pa=0, po=0.0, pd=0.0, yo=0, yd=0, tog=0, tot=0))
    for g in games:
        if not g["final"]:
            continue
        h, a = g["home"]["abbr"], g["away"]["abbr"]
        bx = box.get(g["id"], {})
        for me, op, pf, pa in ((h, a, g["hs"], g["as"]), (a, h, g["as"], g["hs"])):
            r = raw[me]
            mine, theirs = bx.get(me, {}), bx.get(op, {})
            r["g"] += 1
            r["pf"] += pf
            r["pa"] += pa
            r["po"] += mine.get("plays") or DEFAULT_PLAYS
            r["pd"] += theirs.get("plays") or DEFAULT_PLAYS
            r["yo"] += mine.get("yards") or 0
            r["yd"] += theirs.get("yards") or 0
            r["tog"] += mine.get("to") or 0
            r["tot"] += theirs.get("to") or 0
            r["w" if pf > pa else "l" if pf < pa else "t"] += 1

    tg = sum(r["g"] for r in raw.values())
    lg_ppg = sum(r["pf"] for r in raw.values()) / tg if tg else DEFAULT_PPP * DEFAULT_PLAYS
    lg_plays = sum(r["po"] for r in raw.values()) / tg if tg else DEFAULT_PLAYS
    lg_ppp = lg_ppg / lg_plays
    k = PRIOR_GAMES

    out = {}
    for t, r in raw.items():
        g = r["g"]
        pf_pg = (r["pf"] + k * lg_ppg) / (g + k)
        pa_pg = (r["pa"] + k * lg_ppg) / (g + k)
        out[t] = {
            "g": g, "w": r["w"], "l": r["l"], "t": r["t"],
            "record": f"{r['w']}-{r['l']}" + (f"-{r['t']}" if r["t"] else ""),
            "pf": r["pf"], "pa": r["pa"],
            "ppg": r["pf"] / g if g else None, "papg": r["pa"] / g if g else None,
            # valores crudos (para mostrar)
            "off_ppp_raw": r["pf"] / r["po"] if r["po"] else None,
            "def_ppp_raw": r["pa"] / r["pd"] if r["pd"] else None,
            "plays_pg_raw": r["po"] / g if g else None,
            "opp_plays_pg_raw": r["pd"] / g if g else None,
            # valores suavizados (para predecir)
            "off_ppp": (r["pf"] + k * lg_plays * lg_ppp) / (r["po"] + k * lg_plays),
            "def_ppp": (r["pa"] + k * lg_plays * lg_ppp) / (r["pd"] + k * lg_plays),
            "plays_pg": (r["po"] + k * lg_plays) / (g + k),
            "opp_plays_pg": (r["pd"] + k * lg_plays) / (g + k),
            "ypp_off": r["yo"] / r["po"] if r["po"] else None,
            "ypp_def": r["yd"] / r["pd"] if r["pd"] else None,
            "to_margin": r["tot"] - r["tog"],
            "pyth": pf_pg ** PYTH_EXP / (pf_pg ** PYTH_EXP + pa_pg ** PYTH_EXP),
        }
    league = {"ppg": lg_ppg, "plays": lg_plays, "ppp": lg_ppp, "games": tg // 2}
    return out, league


def neutral_team(league):
    return {"g": 0, "w": 0, "l": 0, "t": 0, "record": "0-0", "off_ppp": league["ppp"], "def_ppp": league["ppp"],
            "plays_pg": league["plays"], "opp_plays_pg": league["plays"], "pyth": 0.5}


def srs_ratings(games, lg_ppg):
    """Rating ofensivo/defensivo ajustado por la calidad de los rivales (Simple Rating System)."""
    played = defaultdict(list)
    for g in games:
        if g["final"]:
            h, a = g["home"]["abbr"], g["away"]["abbr"]
            played[h].append((a, g["hs"], g["as"]))
            played[a].append((h, g["as"], g["hs"]))
    O = {t: 0.0 for t in played}
    D = {t: 0.0 for t in played}
    for _ in range(200):
        nO = {t: sum(pf - lg_ppg - D[o] for o, pf, _ in L) / (len(L) + PRIOR_GAMES) for t, L in played.items()}
        nD = {t: sum(pa - lg_ppg - O[o] for o, _, pa in L) / (len(L) + PRIOR_GAMES) for t, L in played.items()}
        if nO:
            mo, md = sum(nO.values()) / len(nO), sum(nD.values()) / len(nD)
            nO = {t: v - mo for t, v in nO.items()}
            nD = {t: v - md for t, v in nD.items()}
        O, D = nO, nD
    return O, D


def run_elo(all_games, cur_season):
    """Elo estilo FiveThirtyEight. Devuelve snapshots antes de cada jornada de la temporada actual."""
    elo = defaultdict(lambda: 1500.0)
    snaps = {}
    last = None
    for g in sorted((g for g in all_games if g["final"]), key=lambda g: (g["season"], g["key"], g["date"])):
        if g["season"] != last:
            if last is not None:
                for t in list(elo):
                    elo[t] = elo[t] * (1 - ELO_REVERT) + 1505 * ELO_REVERT
            last = g["season"]
        if g["season"] == cur_season and g["key"] not in snaps:
            snaps[g["key"]] = dict(elo)
        h, a = g["home"]["abbr"], g["away"]["abbr"]
        diff = elo[h] + (0 if g["neutral"] else ELO_HFA) - elo[a]
        exp_h = 1 / (1 + 10 ** (-diff / 400))
        res = 1.0 if g["hs"] > g["as"] else 0.0 if g["hs"] < g["as"] else 0.5
        mov = abs(g["hs"] - g["as"])
        wdiff = diff if g["hs"] > g["as"] else -diff
        mult = math.log(mov + 1) * (2.2 / (wdiff * 0.001 + 2.2)) if mov else 1.0
        shift = ELO_K * mult * (res - exp_h)
        elo[h] += shift
        elo[a] -= shift
    final = dict(elo)
    if last != cur_season:   # aun no empieza la temporada: aplicar regresion
        final = {t: v * (1 - ELO_REVERT) + 1505 * ELO_REVERT for t, v in final.items()}
    return snaps, final


# ------------------------------------------------------------- prediccion ---

def predict(g, ts, league, O, D, elo, weeks_played, adj=None):
    adj = adj or {"home": 0.0, "away": 0.0, "notes": []}
    h, a = g["home"]["abbr"], g["away"]["abbr"]
    H = ts.get(h) or neutral_team(league)
    A = ts.get(a) or neutral_team(league)
    hfa = 0.0 if g["neutral"] else HFA_POINTS
    lg = league["ppg"]

    # 1) Formula de puntos por jugada (ofensiva propia + defensiva del rival) / 2
    h_off, a_def = H["off_ppp"] * H["plays_pg"], A["def_ppp"] * A["opp_plays_pg"]
    a_off, h_def = A["off_ppp"] * A["plays_pg"], H["def_ppp"] * H["opp_plays_pg"]
    ppp_h, ppp_a = (h_off + a_def) / 2, (a_off + h_def) / 2
    # 2) SRS (ajustado por calendario)
    srs_h, srs_a = lg + O.get(h, 0) + D.get(a, 0), lg + O.get(a, 0) + D.get(h, 0)
    # 3) Elo
    elo_m = (elo.get(h, 1500) - elo.get(a, 1500)) / ELO_PTS
    # 4) Pitagorico + log5
    pa_, pb_ = H["pyth"], A["pyth"]
    p5 = (pa_ - pa_ * pb_) / (pa_ + pb_ - 2 * pa_ * pb_) if (pa_ + pb_ - 2 * pa_ * pb_) else 0.5
    pyth_m = SIGMA * NormalDist().inv_cdf(min(max(p5, 0.02), 0.98))

    raw = [
        ("ppp", "Puntos por jugada (tu formula)", ppp_h - ppp_a, ppp_h, ppp_a),
        ("srs", "SRS - ajustado por rival", srs_h - srs_a, srs_h, srs_a),
        ("elo", "Elo (historial + temporada)", elo_m, None, None),
        ("pyth", "Pitagorico (log5)", pyth_m, None, None),
    ]
    f = min(1.0, weeks_played / 4)   # con pocas jornadas, pesa mas el Elo
    w = {k: v * (f if k != "elo" else 1) for k, v in BASE_WEIGHTS.items()}
    w["elo"] += (1 - f) * 0.70
    tw = sum(w.values())
    w = {k: v / tw for k, v in w.items()}

    adj_m, adj_t = adj["home"] - adj["away"], adj["home"] + adj["away"]
    models = []
    for key, name, m, sh, sa in raw:
        mh = m + hfa + adj_m
        md = {"key": key, "name": name, "margin": round(mh, 1), "prob_home": round(PHI(mh / SIGMA), 3),
              "pick": h if mh >= 0 else a, "weight": round(w[key], 2)}
        if sh is not None:
            md["hs"], md["as"] = round(sh + hfa / 2 + adj["home"], 1), round(sa - hfa / 2 + adj["away"], 1)
        models.append(md)

    margin = sum(w[k] * m for k, _, m, _, _ in raw) + hfa + adj_m
    total = (ppp_h + ppp_a + srs_h + srs_a) / 2 + adj_t
    prob_h = PHI(margin / SIGMA)
    pick = h if margin >= 0 else a
    agree = sum(1 for md in models if md["pick"] == pick) / len(models)
    spread = pstdev([md["margin"] for md in models])
    sample = min(1.0, weeks_played / 8)
    cert = 100 * (0.45 * min(1.0, abs(margin) / 10) + 0.35 * agree + 0.20 * sample) - min(10, spread)
    cert = max(1, min(99, round(cert)))
    level = "Alta" if cert >= 70 else "Media" if cert >= 50 else "Baja"

    def inp(T):
        return {k: round(T[k], 4) for k in ("off_ppp", "def_ppp", "plays_pg", "opp_plays_pg")}

    return {
        "hs": round((total + margin) / 2, 1), "as": round((total - margin) / 2, 1),
        "margin": round(margin, 1), "total": round(total, 1), "prob_home": round(prob_h, 3),
        "pick": pick, "prob_pick": round(max(prob_h, 1 - prob_h), 3),
        "certainty": cert, "level": level, "agree": round(agree, 2), "models": models, "sample": weeks_played,
        "adj": {"home": round(adj["home"], 2), "away": round(adj["away"], 2), "notes": adj["notes"]},
        "rec_home": H["record"], "rec_away": A["record"],
        "inputs": {"home": inp(H), "away": inp(A), "h_off": round(h_off, 1), "a_def": round(a_def, 1),
                   "a_off": round(a_off, 1), "h_def": round(h_def, 1), "hfa": hfa},
    }


def grade(g, p):
    """Compara prediccion con resultado real."""
    if not g["final"]:
        return None
    m_real = g["hs"] - g["as"]
    if m_real == 0:
        return {"tie": True}
    winner = g["home"]["abbr"] if m_real > 0 else g["away"]["abbr"]
    r = {"correct": p["pick"] == winner, "err_margin": round(abs(p["margin"] - m_real), 1),
         "err_total": round(abs(p["total"] - (g["hs"] + g["as"])), 1),
         "models": {md["key"]: md["pick"] == winner for md in p["models"]}}
    if g.get("vegas_margin") not in (None, 0):
        r["vegas"] = (g["vegas_margin"] > 0) == (m_real > 0)
        r["ats"] = (p["margin"] - g["vegas_margin"] > 0) == (m_real - g["vegas_margin"] > 0) \
            if m_real != g["vegas_margin"] and p["margin"] != g["vegas_margin"] else None
    return r


def summarize(results):
    graded = [r for r in results if r and not r.get("tie")]
    n = len(graded)
    if not n:
        return None
    s = {"n": n, "correct": sum(r["correct"] for r in graded),
         "mae": round(sum(r["err_margin"] for r in graded) / n, 1),
         "mae_total": round(sum(r["err_total"] for r in graded) / n, 1),
         "models": {k: sum(r["models"][k] for r in graded) for k in BASE_WEIGHTS}}
    v = [r["vegas"] for r in graded if "vegas" in r]
    if v:
        s["vegas_n"], s["vegas_correct"] = len(v), sum(v)
    ats = [r["ats"] for r in graded if r.get("ats") is not None]
    if ats:
        s["ats_n"], s["ats_correct"] = len(ats), sum(ats)
    return s


SCHEDULE = [(1, 3), (3, 14), (6, 9)]   # (dia: 0=lunes, hora): martes 3am, jueves 2pm, domingo 9am


def next_run(now):
    cands = []
    for wd, hr in SCHEDULE:
        d = now + timedelta(days=(wd - now.weekday()) % 7)
        t = d.replace(hour=hr, minute=0, second=0, microsecond=0)
        cands.append(t if t > now else t + timedelta(days=7))
    return min(cands)


# ------------------------------------------------------------ contrasena ---

PASSWORD_FILE = os.path.join(BASE, "password.txt")
PBKDF2_ITER = 250_000


def get_password():
    """Contrasena del sitio: variable NFL_PASSWORD (GitHub) o archivo password.txt (local)."""
    p = os.environ.get("NFL_PASSWORD", "").strip()
    if not p and os.path.exists(PASSWORD_FILE):
        with open(PASSWORD_FILE, encoding="utf-8") as f:
            p = f.read().strip()
    return p or None


def encrypt(text, password):
    """AES-256-GCM con llave derivada por PBKDF2-SHA256 (compatible con WebCrypto del navegador)."""
    import base64
    import hashlib
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt, iv = os.urandom(16), os.urandom(12)
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITER, dklen=32)
    data = AESGCM(key).encrypt(iv, text.encode("utf-8"), None)
    b = lambda x: base64.b64encode(x).decode("ascii")
    return {"salt": b(salt), "iv": b(iv), "iter": PBKDF2_ITER, "data": b(data)}


# ------------------------------------------------------------------- main ---

def main():
    log("== Iniciando actualizacion ==")
    sb = get_json(f"{API}/scoreboard")
    season = sb["season"]["year"]
    log(f"Temporada {season}")

    history = []
    for y in (season - 2, season - 1):
        history += fetch_season(y, include_post=True)
    games = fetch_season(season, include_post=False)
    reg = defaultdict(list)
    for g in games:
        reg[g["week"]].append(g)
    if len(reg) == 18 and all(g["final"] for g in games):
        games += [g for w in POST_LABELS for g in fetch_week(season, 3, w)]
    log(f"  {len(games)} partidos en {season} ({sum(g['final'] for g in games)} terminados)")

    box = fetch_boxscores(season, games)
    snaps, elo_now = run_elo(history + games, season)

    by_key = defaultdict(list)
    for g in games:
        by_key[g["key"]].append(g)
    keys = sorted(by_key)
    pending = [k for k in keys if not all(g["final"] for g in by_key[k])]
    current = pending[0] if pending else keys[-1]
    extras = fetch_extras(season, by_key[current])

    teams_meta = {}
    for g in games:
        for side in ("home", "away"):
            t = g[side]
            teams_meta.setdefault(t["abbr"], {k: t[k] for k in ("name", "short", "color", "alt", "logo")})

    weeks_out, all_results = [], []
    for k in [k for k in keys if k <= current]:
        prev = [g for g in games if g["key"] < k and g["final"]]
        ts, league = team_stats(prev, box)
        O, D = srs_ratings(prev, league["ppg"])
        elo = snaps.get(k, elo_now)
        weeks_played = len({g["key"] for g in prev})
        wk_games, results = [], []
        for g in sorted(by_key[k], key=lambda g: g["date"]):
            ex = extras.get(g["id"])
            p = predict(g, ts, league, O, D, elo, weeks_played, auto_adjust(g, ex))
            r = grade(g, p)
            results.append(r)
            wk_games.append({**g, "pred": p, "result": r, "extra": ex})
        if wk_games[0]["stype"] == 2:
            playing = {t for g in wk_games for t in (g["home"]["abbr"], g["away"]["abbr"])}
            bye = sorted(set(teams_meta) - playing)
        else:
            bye = []
        all_results += [(r, g["pred"]["level"]) for r, g in zip(results, wk_games)]
        last_week = max((g["key"] for g in prev), default=None)
        weeks_out.append({
            "key": k, "label": week_label(wk_games[0]["stype"], wk_games[0]["week"]),
            "stats_through": week_label(2 if last_week <= 18 else 3, last_week if last_week <= 18 else last_week - 18)
            if last_week else None,
            "games": wk_games, "bye": bye, "summary": summarize(results), "league": league,
        })

    # estadisticas actuales de cada equipo (todo lo jugado)
    ts_now, league_now = team_stats([g for g in games if g["final"]], box)
    O, D = srs_ratings([g for g in games if g["final"]], league_now["ppg"])
    teams_out = {}
    for t, meta in teams_meta.items():
        s = ts_now.get(t, neutral_team(league_now))
        teams_out[t] = {**meta, **{kk: (round(v, 4) if isinstance(v, float) else v) for kk, v in s.items()},
                        "elo": round(elo_now.get(t, 1500)), "srs_off": round(O.get(t, 0), 2),
                        "srs_def": round(D.get(t, 0), 2), "srs": round(O.get(t, 0) - D.get(t, 0), 2)}

    by_level = {}
    for lvl in ("Alta", "Media", "Baja"):
        by_level[lvl] = summarize([r for r, l in all_results if l == lvl])

    now = datetime.now(TZ) if TZ else datetime.now().astimezone()
    out = {
        "generated": now.isoformat(timespec="seconds"),
        "next_update": next_run(now).isoformat(timespec="minutes"),
        "season": season, "current_key": current, "teams": teams_out, "weeks": weeks_out,
        "league": league_now, "season_summary": summarize([r for r, _ in all_results]), "by_level": by_level,
        "params": {"hfa": HFA_POINTS, "sigma": SIGMA, "prior_games": PRIOR_GAMES, "weights": BASE_WEIGHTS,
                   "elo_k": ELO_K, "elo_hfa": ELO_HFA, "pyth_exp": PYTH_EXP},
    }
    os.makedirs(DATA_DIR, exist_ok=True)
    password = get_password()
    with open(OUT_FILE + ".tmp", "w", encoding="utf-8") as f:
        if password:
            f.write("window.NFL_ENC = ")
            json.dump(encrypt(json.dumps(out, ensure_ascii=False), password), f)
        else:
            f.write("window.NFL_DATA = ")
            json.dump(out, f, ensure_ascii=False)
        f.write(";\n")
    os.replace(OUT_FILE + ".tmp", OUT_FILE)
    log("  datos cifrados con contrasena" if password else "  datos sin contrasena")
    ss = out["season_summary"]
    log(f"Listo: jornada actual = {weeks_out[-1]['label']}"
        + (f" | aciertos temporada {ss['correct']}/{ss['n']}" if ss else ""))


if __name__ == "__main__":
    try:
        main()
    except Exception as ex:
        log(f"ERROR: {ex!r}")
        sys.exit(1)
