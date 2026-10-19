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
FORM_DECAY = 1.0         # forma reciente (0.85 = cada jornada hacia atras pesa 15% menos). Desactivado: en la
#                          prueba de semanas 2-6 bajo los aciertos; volver a probar a mitad de temporada
DIV_POINTS = 1.0         # partido divisional: el favorito pierde hasta 1 pt de margen
TRAVEL_POINTS = 1.0      # equipo del Pacifico jugando temprano (antes de 2 p.m. ET) en el Este
DIVISIONS = {
    "AFC Este": "BUF MIA NE NYJ", "AFC Norte": "BAL CIN CLE PIT", "AFC Sur": "HOU IND JAX TEN", "AFC Oeste": "DEN KC LV LAC",
    "NFC Este": "DAL NYG PHI WSH", "NFC Norte": "CHI DET GB MIN", "NFC Sur": "ATL CAR NO TB", "NFC Oeste": "ARI LAR SF SEA",
}
TEAM_DIV = {t: d for d, ts in DIVISIONS.items() for t in ts.split()}
EASTERN = set("BUF MIA NE NYJ BAL CIN CLE PIT IND JAX TB ATL CAR DET NYG PHI WSH".split())
PACIFIC = set("SEA SF LAR LAC LV ARI".split())
VEGAS_WEIGHT = 0.25      # peso del moneyline de Las Vegas dentro del consenso (si hay momio)
AN_API = "https://api.actionnetwork.com/web/v2/scoreboard/nfl"   # momios y % de apuestas del publico
AN_ABBR = {"JAC": "JAX", "LA": "LAR", "WAS": "WSH"}
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
        return {"abbr": t["abbreviation"], "id": t.get("id"), "name": t.get("displayName"), "short": t.get("shortDisplayName"),
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
        qb, qb_att = {}, {}
        for t in d.get("leaders", []):
            for c in t.get("leaders", []):
                if c.get("name") == "passingYards" and c.get("leaders"):
                    ab = t["team"]["abbreviation"]
                    qb[ab] = c["leaders"][0]["athlete"].get("displayName")
                    try:   # "97/162, 942 YDS..." -> 162 intentos
                        qb_att[ab] = int(c["leaders"][0]["displayValue"].split(",")[0].split("/")[1])
                    except (KeyError, IndexError, ValueError):
                        pass
        depth = {g[s]["abbr"]: fetch_depth_qbs(g[s].get("id")) for s in ("home", "away")}
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
            "qb": qb, "qb_att": qb_att, "depth": depth, "injuries": inj,
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


def american_prob(odds):
    """Momio americano -> probabilidad implicita (con comision)."""
    o = float(odds)
    return 100 / (o + 100) if o > 0 else -o / (-o + 100)


def fetch_market(season, games):
    """Moneyline (consenso y apertura) y % de boletos / dinero del publico, de Action Network.
    Se guarda por partido; despues de que empieza el partido ya no se toca (queda el momio de cierre)."""
    path = os.path.join(CACHE_DIR, f"market_{season}.json")
    market = load_json(path, {})
    weeks = sorted({g["week"] for g in games if g["stype"] == 2 and (g["id"] not in market or g["state"] == "pre")})
    if not weeks:
        return market
    by_pair = {(g["week"], g["home"]["abbr"], g["away"]["abbr"]): g for g in games if g["stype"] == 2}

    def one(week):
        try:
            return week, get_json(f"{AN_API}?bookIds=15,30&periods=event&week={week}&season={season}")
        except Exception as ex:
            log(f"  aviso: no se pudieron leer momios de la semana {week}: {ex}")
            return week, {}

    log(f"  descargando momios de {len(weeks)} semana(s)...")
    with ThreadPoolExecutor(6) as ex:
        for week, d in ex.map(one, weeks):
            for x in d.get("games", []):
                T = {t["id"]: AN_ABBR.get(t["abbr"], t["abbr"]) for t in x.get("teams", [])}
                g = by_pair.get((week, T.get(x.get("home_team_id")), T.get(x.get("away_team_id"))))
                if not g or (g["id"] in market and g["state"] != "pre"):
                    continue
                mk = x.get("markets") or {}

                def ml(book):
                    return {o["side"]: o for o in ((mk.get(book) or {}).get("event") or {}).get("moneyline") or []}
                cons, opn = ml("15"), ml("30")
                if "home" not in cons or "away" not in cons:
                    continue

                def pct(side, kind):
                    return (((cons[side].get("bet_info") or {}).get(kind)) or {}).get("percent")
                ih, ia = american_prob(cons["home"]["odds"]), american_prob(cons["away"]["odds"])
                market[g["id"]] = {
                    "ml_h": cons["home"]["odds"], "ml_a": cons["away"]["odds"],
                    "open_h": (opn.get("home") or {}).get("odds"), "open_a": (opn.get("away") or {}).get("odds"),
                    "p_h": round(ih / (ih + ia), 4),      # probabilidad sin comision
                    "tickets_h": pct("home", "tickets"), "tickets_a": pct("away", "tickets"),
                    "money_h": pct("home", "money"), "money_a": pct("away", "money"),
                }
    save_json(path, market)
    return market


QB_PENALTY = {"Out": 5.0, "Doubtful": 3.5, "Questionable": 1.0}
QB_CHANGE = 5.0          # puntos que vale cambiar del QB titular al suplente
ATT_PER_GAME = 33.0      # pases intentados por partido de un QB titular


def fetch_depth_qbs(team_id):
    """QBs en orden del depth chart de ESPN, con su estatus de lesion: [{name, status}]."""
    if not team_id:
        return None
    try:
        d = get_json(f"{API}/teams/{team_id}/depthcharts")
    except Exception:
        return None
    for dc in d.get("depthchart", []):
        pos = dc.get("positions") or {}
        qb = pos.get("qb") or pos.get("QB")
        if qb:
            out = []
            for a in qb.get("athletes", []):
                inj = a.get("injuries") or []
                out.append({"name": a.get("displayName") or a.get("fullName"),
                            "status": inj[0].get("status") if inj and isinstance(inj[0], dict) else None})
            return out
    return None


def qb_adjust(g, ex, gp, adj):
    """Detecta quien sera el QB titular (depth chart) y lo compara con el QB que genero las estadisticas."""
    for side in ("home", "away"):
        abbr = g[side]["abbr"]
        leader = (ex.get("qb") or {}).get(abbr)          # lider de pases = QB de las estadisticas
        if not leader:
            continue
        inj = {p["name"]: p["status"] for p in (ex.get("injuries") or {}).get(abbr, []) if p["pos"] == "QB"}
        depth = (ex.get("depth") or {}).get(abbr)
        if depth:
            for p in depth:                              # el estatus mas reciente gana
                if p.get("status"):
                    inj[p["name"]] = p["status"]
            healthy = [p["name"] for p in depth if inj.get(p["name"]) != "Out"]
            starter = healthy[0] if healthy else None
        else:
            starter = leader if inj.get(leader) != "Out" else None
        ex.setdefault("qb_start", {})[abbr] = starter
        if starter and starter != leader:
            # cuanto de las estadisticas del equipo se hizo con el QB que ya no juega
            att = (ex.get("qb_att") or {}).get(abbr)
            share = min(1.0, att / (ATT_PER_GAME * gp.get(abbr, 1))) if att else 1.0
            pen = round(QB_CHANGE * share * 2) / 2
            if pen:
                adj[side] -= pen
                why = {"Out": "fuera", "Doubtful": "dudoso"}.get(inj.get(leader), "no es el titular")
                adj["notes"].append(f"🔄 {abbr}: {leader} {why}, titular probable {starter}: -{pen:g} pts")
        elif inj.get(leader) in QB_PENALTY and inj.get(leader) != "Out":
            pen = QB_PENALTY[inj[leader]]
            adj[side] -= pen
            st = {"Doubtful": "dudoso", "Questionable": "en duda"}[inj[leader]]
            adj["notes"].append(f"🚑 QB titular {leader} ({abbr}) {st}: -{pen:g} pts a {abbr}")
        elif not starter:
            adj[side] -= QB_CHANGE
            adj["notes"].append(f"🚑 QB titular {leader} ({abbr}) FUERA: -{QB_CHANGE:g} pts a {abbr}")


BYE_POINTS = 1.0     # equipo que viene de semana de descanso (rival no)
REST_POINTS = 0.5    # ventaja por 3+ dias mas de descanso que el rival (ej. jugo el jueves anterior)


def parse_date(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def rest_days(games):
    """Dias de descanso de cada equipo antes de cada partido: {(id, abbr): dias o None}."""
    by_team = defaultdict(list)
    for g in games:
        for side in ("home", "away"):
            by_team[g[side]["abbr"]].append(g)
    out = {}
    for t, lst in by_team.items():
        lst.sort(key=lambda g: g["date"])
        prev = None
        for g in lst:
            # fecha en hora del este de EUA (UTC-5): el Sunday Night en UTC ya es lunes
            et = lambda x: (parse_date(x["date"]) - timedelta(hours=5)).date()
            out[(g["id"], t)] = (et(g) - et(prev)).days if prev else None
            prev = g
    return out


def rest_adjust(g, rest, adj):
    """Bye (13+ dias de descanso) = +1 pt; si nadie viene de bye, 3+ dias mas de descanso = +0.5 pt."""
    h, a = g["home"]["abbr"], g["away"]["abbr"]
    dh, da = rest.get((g["id"], h)), rest.get((g["id"], a))
    if dh is None or da is None:
        return
    bh, ba = dh >= 13, da >= 13
    if bh != ba:
        side, t = ("home", h) if bh else ("away", a)
        adj[side] += BYE_POINTS
        adj["notes"].append(f"⏸ {t} viene de semana de descanso (bye): +{BYE_POINTS:g} pt")
    elif not bh and abs(dh - da) >= 3:
        side, t, more, less = ("home", h, dh, da) if dh > da else ("away", a, da, dh)
        adj[side] += REST_POINTS
        adj["notes"].append(f"🛌 {t} con {more} dias de descanso vs {less} del rival: +{REST_POINTS:g} pt")


def auto_adjust(g, ex, rest=None, gp=None):
    """Ajuste automatico en puntos para cada equipo: descanso/bye, QB titular lesionado y clima."""
    adj = {"home": 0.0, "away": 0.0, "notes": []}
    if rest:
        rest_adjust(g, rest, adj)
    if not ex:
        return adj
    qb_adjust(g, ex, gp or {}, adj)
    w = ex.get("weather")
    if w and not g.get("indoor"):
        per = 0.0
        gust, precip, temp = w.get("gust") or 0, w.get("precip") or 0, w.get("temp")
        if gust >= 25:
            per += 2.0
            adj["notes"].append(f"🌬️ Viento muy fuerte ({round(gust * 1.609)} km/h): -4 al total")
        elif gust >= 18:
            per += 1.0
            adj["notes"].append(f"🌬️ Viento fuerte ({round(gust * 1.609)} km/h): -2 al total")
        if precip >= 70:
            per += 1.0
            adj["notes"].append(f"🌧️ Lluvia/nieve probable ({precip}%): -2 al total")
        elif precip >= 40:
            per += 0.5
            adj["notes"].append(f"🌧️ Posible lluvia ({precip}%): -1 al total")
        if temp is not None and temp <= 20:
            per += 0.75
            adj["notes"].append(f"🥶 Frio extremo ({round((temp - 32) / 1.8)}°C): -1.5 al total")
        adj["home"] -= per
        adj["away"] -= per
    return adj


# ---------------------------------------------------------- estadisticas ---

def team_stats(games, box):
    raw = defaultdict(lambda: dict(g=0, w=0, l=0, t=0, pf=0, pa=0, po=0.0, pd=0.0, yo=0, yd=0, tog=0, tot=0,
                                   wg=0.0, wpf=0.0, wpa=0.0, wpo=0.0, wpd=0.0))
    last_key = max((g["key"] for g in games if g["final"]), default=0)
    for g in games:
        if not g["final"]:
            continue
        wt = FORM_DECAY ** (last_key - g["key"])   # partidos recientes pesan mas
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
            r["wg"] += wt
            r["wpf"] += wt * pf
            r["wpa"] += wt * pa
            r["wpo"] += wt * (mine.get("plays") or DEFAULT_PLAYS)
            r["wpd"] += wt * (theirs.get("plays") or DEFAULT_PLAYS)

    tg = sum(r["g"] for r in raw.values())
    lg_ppg = sum(r["pf"] for r in raw.values()) / tg if tg else DEFAULT_PPP * DEFAULT_PLAYS
    lg_plays = sum(r["po"] for r in raw.values()) / tg if tg else DEFAULT_PLAYS
    lg_ppp = lg_ppg / lg_plays
    k = PRIOR_GAMES

    out = {}
    for t, r in raw.items():
        g, wg = r["g"], r["wg"]
        pf_pg = (r["wpf"] + k * lg_ppg) / (wg + k)
        pa_pg = (r["wpa"] + k * lg_ppg) / (wg + k)
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
            "off_ppp": (r["wpf"] + k * lg_plays * lg_ppp) / (r["wpo"] + k * lg_plays),
            "def_ppp": (r["wpa"] + k * lg_plays * lg_ppp) / (r["wpd"] + k * lg_plays),
            "plays_pg": (r["wpo"] + k * lg_plays) / (wg + k),
            "opp_plays_pg": (r["wpd"] + k * lg_plays) / (wg + k),
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
    last_key = max((g["key"] for g in games if g["final"]), default=0)
    for g in games:
        if g["final"]:
            h, a = g["home"]["abbr"], g["away"]["abbr"]
            wt = FORM_DECAY ** (last_key - g["key"])
            played[h].append((a, g["hs"], g["as"], wt))
            played[a].append((h, g["as"], g["hs"], wt))
    O = {t: 0.0 for t in played}
    D = {t: 0.0 for t in played}
    for _ in range(200):
        nO = {t: sum(w * (pf - lg_ppg - D[o]) for o, pf, _, w in L) / (sum(x[3] for x in L) + PRIOR_GAMES)
              for t, L in played.items()}
        nD = {t: sum(w * (pa - lg_ppg - O[o]) for o, _, pa, w in L) / (sum(x[3] for x in L) + PRIOR_GAMES)
              for t, L in played.items()}
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

def situational(g, margin, adj):
    """Partido divisional (mas cerrado) y equipo del Pacifico jugando temprano en el Este."""
    h, a = g["home"]["abbr"], g["away"]["abbr"]
    if DIV_POINTS and TEAM_DIV.get(h) and TEAM_DIV.get(h) == TEAM_DIV.get(a) and abs(margin) > 0.1:
        dog_side, dog = ("away", a) if margin > 0 else ("home", h)
        pts = round(min(DIV_POINTS, abs(margin) / 2), 1)
        adj[dog_side] += pts
        adj["notes"].append(f"🤝 Partido divisional ({TEAM_DIV[h]}): suelen ser cerrados, +{pts:g} pt a {dog}")
    if TRAVEL_POINTS and not g["neutral"] and h in EASTERN and a in PACIFIC:
        utc = parse_date(g["date"])   # horario de verano en EUA: ~2do dom. de marzo a 1er dom. de noviembre
        dst = (3 < utc.month < 11) or (utc.month == 3 and utc.day >= 8) or (utc.month == 11 and utc.day < 7)
        et_hour = (utc - timedelta(hours=4 if dst else 5)).hour
        if et_hour < 14:
            adj["away"] -= TRAVEL_POINTS
            adj["notes"].append(f"✈️ {a} viaja de la costa del Pacifico y juega temprano ({et_hour}:00 ET): -{TRAVEL_POINTS:g} pt")


def predict(g, ts, league, O, D, elo, weeks_played, adj=None, market=None):
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

    adj = {"home": adj["home"], "away": adj["away"], "notes": list(adj["notes"])}
    situational(g, sum(w[k] * m for k, _, m, _, _ in raw) + hfa + adj["home"] - adj["away"], adj)
    adj_m, adj_t = adj["home"] - adj["away"], adj["home"] + adj["away"]
    if market and market.get("p_h"):
        # 5) Las Vegas: el momio ya incluye local, lesiones y clima -> no se le suman nuestros ajustes
        m_v = SIGMA * NormalDist().inv_cdf(min(max(market["p_h"], 0.01), 0.99))
        raw.append(("vegas", "Las Vegas (moneyline)", m_v - hfa - adj_m, None, None))
        w = {k: v * (1 - VEGAS_WEIGHT) for k, v in w.items()}
        w["vegas"] = VEGAS_WEIGHT
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


MODEL_KEYS = list(BASE_WEIGHTS) + ["vegas"]


def summarize(results):
    graded = [r for r in results if r and not r.get("tie")]
    n = len(graded)
    if not n:
        return None
    s = {"n": n, "correct": sum(r["correct"] for r in graded),
         "mae": round(sum(r["err_margin"] for r in graded) / n, 1),
         "mae_total": round(sum(r["err_total"] for r in graded) / n, 1),
         "models": {k: sum(r["models"].get(k, False) for r in graded) for k in MODEL_KEYS},
         "models_n": {k: sum(k in r["models"] for r in graded) for k in MODEL_KEYS}}
    v = [r["vegas"] for r in graded if "vegas" in r]
    if v:
        s["vegas_n"], s["vegas_correct"] = len(v), sum(v)
    ats = [r["ats"] for r in graded if r.get("ats") is not None]
    if ats:
        s["ats_n"], s["ats_correct"] = len(ats), sum(ats)
    return s


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
    market = fetch_market(season, [g for g in games if g["key"] <= current])
    rest = rest_days(games)

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
            p = predict(g, ts, league, O, D, elo, weeks_played, auto_adjust(g, ex, rest, {t: v["g"] for t, v in ts.items()}),
                        market.get(g["id"]))
            r = grade(g, p)
            results.append(r)
            wk_games.append({**g, "pred": p, "result": r, "extra": ex, "market": market.get(g["id"])})
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
        "season": season, "current_key": current, "teams": teams_out, "weeks": weeks_out,
        "league": league_now, "season_summary": summarize([r for r, _ in all_results]), "by_level": by_level,
        "params": {"hfa": HFA_POINTS, "sigma": SIGMA, "prior_games": PRIOR_GAMES, "weights": BASE_WEIGHTS, "vegas_weight": VEGAS_WEIGHT,
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
