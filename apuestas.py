"""
Recomendaciones de apuestas: directas de equipos (moneyline, spread, total),
props de jugadores (yardas, recepciones, pases de TD), candidatos a anotar TD y parlays.

- Probabilidades de equipo: nuestros 4 modelos SIN Vegas (para comparar contra el momio).
- Props: promedio del jugador ajustado por la defensa rival, mezclado con la linea del casino.
- Cada recomendacion se califica al terminar el partido y se lleva historial:
  "simulado" = generado despues con la linea de cierre; "real" = guardado antes del partido.
"""
import math
import os
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from itertools import combinations
from statistics import NormalDist, pstdev

PHI = NormalDist().cdf
SIGMA_M = 13.5          # desviacion del margen final
SIGMA_T = 13.0          # desviacion del total de puntos
PROP_ODDS = -110        # los props de ESPN no traen momio: se asume el estandar
MIN_EV = {"ml": 0.05, "sp": 0.04, "tot": 0.04, "prop": 0.05}
ENABLED = {"ml": False, "sp": True, "tot": False}   # ML: acertaba igual que el momio (sin ventaja); totales perdian -32%
# calibracion (prueba semanas 3-8 de 2026): p_real = p_casino + CAL * (p_modelo - p_casino)
CAL = {"ml": 0.0, "sp": 1.0, "tot": 0.5, "prop": 0.8}
# props: solo "menos de" en recepciones y yardas por tierra (en 2026 los unders pegaron ~55% y nuestros overs perdian)
PROP_SIDES = {"rec": ("under",), "ry": ("under",)}
MIN_P_ML = 0.38         # no recomendar moneylines de muy poca probabilidad
MIN_GAMES = 3           # juegos minimos del jugador para proyectar un prop
MIN_LINE = {"py": 150, "ry": 25, "recy": 20, "rec": 2.5, "ptd": 0.5}   # solo lineas principales (las bajas pagan muy distinto a -110)
MAX_P_PROP = 0.64       # si el modelo difiere demasiado del casino, casi siempre el casino sabe algo (prueba: >=64% acerto 44%)
TD_SCALE = 0.72         # calibracion: los candidatos a TD anotaban menos de lo proyectado
CV = {"py": 0.30, "ry": 0.55, "recy": 0.60, "rec": 0.45}
PROP_TYPES = {
    "Total Passing Yards (incl. overtime)": "py",
    "Total Rushing Yards (incl. overtime)": "ry",
    "Total Receiving Yards (incl. overtime)": "recy",
    "Total Receptions (incl. overtime)": "rec",
    "Total Passing Touchdowns (incl. overtime)": "ptd",
}
PROP_NAMES = {"py": "yardas por pase", "ry": "yardas por tierra", "recy": "yardas por recepción",
              "rec": "recepciones", "ptd": "pases de TD"}
DEF_KEY = {"py": "py", "ptd": "ptd", "ry": "ry", "recy": "py", "rec": "rec"}
SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"
CORE = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"


def dec(odds):
    o = float(odds)
    return 1 + o / 100 if o > 0 else 1 + 100 / -o


def implied(odds):
    return 1 / dec(odds)


def stars(ev):
    return 3 if ev >= 0.12 else 2 if ev >= 0.08 else 1


# ------------------------------------------------------------------ datos ---

def fetch_players(season, games, H):
    """Estadisticas por jugador de cada partido terminado (pases, carreras, recepciones)."""
    path = os.path.join(H["cache_dir"], f"players_{season}.json")
    cache = H["load_json"](path, {})
    need = [g for g in games if g["final"] and g["id"] not in cache]
    if not need:
        return cache

    def num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0

    def one(g):
        try:
            d = H["get_json"](f"{SITE}/summary?event={g['id']}")
        except Exception:
            return g["id"], None
        out = {}
        for t in (d.get("boxscore") or {}).get("players", []):
            team = t["team"]["abbreviation"]
            for s in t.get("statistics", []):
                keys = s.get("keys") or []
                for a in s.get("athletes", []):
                    st = dict(zip(keys, a.get("stats", [])))
                    aid = a["athlete"]["id"]
                    p = out.setdefault(aid, {"n": a["athlete"].get("displayName"), "t": team})
                    if s["name"] == "passing":
                        c, att = (st.get("completions/passingAttempts", "0/0").split("/") + ["0"])[:2]
                        p.update(pa=num(att), pc=num(c), py=num(st.get("passingYards")), ptd=num(st.get("passingTouchdowns")))
                    elif s["name"] == "rushing":
                        p.update(ra=num(st.get("rushingAttempts")), ry=num(st.get("rushingYards")),
                                 rtd=num(st.get("rushingTouchdowns")))
                    elif s["name"] == "receiving":
                        p.update(rec=num(st.get("receptions")), recy=num(st.get("receivingYards")),
                                 rectd=num(st.get("receivingTouchdowns")), tgt=num(st.get("receivingTargets")))
        return g["id"], out or None

    H["log"](f"  descargando estadisticas de jugadores de {len(need)} partidos...")
    with ThreadPoolExecutor(8) as ex:
        for gid, out in ex.map(one, need):
            if out:
                cache[gid] = out
    H["save_json"](path, cache)
    return cache


def fetch_props(season, games, H):
    """Lineas de props por jugador (DraftKings via ESPN). Partidos por jugar: se refrescan; jugados: linea de cierre."""
    path = os.path.join(H["cache_dir"], f"props_{season}.json")
    cache = H["load_json"](path, {})
    need = [g for g in games if g["state"] == "pre" or (g["final"] and g["id"] not in cache)]
    if not need:
        return cache

    def one(g):
        url = f"{CORE}/events/{g['id']}/competitions/{g['id']}/odds/100/propBets?limit=1000"
        try:
            d = H["get_json"](url)
        except Exception:
            return g["id"], None
        props, atd = defaultdict(dict), []
        for it in d.get("items", []):
            name = (it.get("type") or {}).get("name", "")
            aid = (it.get("athlete") or {}).get("$ref", "").split("/athletes/")[-1].split("?")[0]
            if not aid:
                continue
            if name == "Anytime Touchdown Scorer":
                atd.append(aid)
                continue
            key = PROP_TYPES.get(name)
            line = (((it.get("current") or {}).get("target")) or {}).get("value")
            if key and line is not None:
                props[aid][key] = line
        return g["id"], {"props": dict(props), "atd": sorted(set(atd))} if props or atd else None

    H["log"](f"  descargando props de jugadores de {len(need)} partidos...")
    with ThreadPoolExecutor(6) as ex:
        for gid, out in ex.map(one, need):
            if out:
                cache[gid] = out
    H["save_json"](path, cache)
    return cache


# ------------------------------------------------------------ proyeccion ---

def history_before(games, players, key):
    """Historial por jugador y defensa permitida por equipo, solo con partidos anteriores a la jornada `key`."""
    hist = defaultdict(list)
    dfn = defaultdict(lambda: defaultdict(float))
    for g in sorted((g for g in games if g["final"] and g["key"] < key), key=lambda g: g["date"]):
        pl = players.get(g["id"])
        if not pl:
            continue
        h, a = g["home"]["abbr"], g["away"]["abbr"]
        for aid, p in pl.items():
            hist[aid].append(p)
            opp = a if p["t"] == h else h
            for k in ("py", "ptd", "ry", "rec", "rtd", "rectd"):
                dfn[opp][k] += p.get(k, 0)
        for t in (h, a):
            dfn[t]["g"] += 1
    tot_g = sum(v["g"] for v in dfn.values()) or 1
    lg = {k: sum(v[k] for v in dfn.values()) / tot_g for k in ("py", "ptd", "ry", "rec")}
    lg["td"] = sum(v["rtd"] + v["rectd"] for v in dfn.values()) / tot_g
    return hist, dfn, lg


def relevant(p, k):
    if k in ("py", "ptd"):
        return p.get("pa", 0) >= 10
    if k == "ry":
        return p.get("ra", 0) >= 1
    return p.get("tgt", 0) >= 1 or p.get("rec", 0) >= 1


def opp_factor(dfn, lg, opp, k):
    d = dfn.get(opp)
    if not d or not lg.get(k):
        return 1.0
    allowed = (d[k] + 2 * lg[k]) / (d["g"] + 2)
    return (allowed / lg[k]) ** 0.5


def project_prop(hist, dfn, lg, aid, k, line, opp):
    games = [p for p in hist.get(aid, []) if relevant(p, k)][-8:]
    n = len(games)
    if n < MIN_GAMES:
        return None
    vals = [p.get(k, 0) for p in games]
    raw = sum(vals) / n * opp_factor(dfn, lg, opp, DEF_KEY[k])
    proj = (n * raw + 2 * line) / (n + 2)                 # mezcla con la linea del casino
    if k == "ptd":                                        # pases de TD: Poisson
        lam = max(proj, 0.05)
        under = sum(math.exp(-lam) * lam ** j / math.factorial(j) for j in range(int(math.floor(line)) + 1))
        p_over = 1 - under
    else:
        s = pstdev(vals)
        sd = math.sqrt((n * s * s + 4 * (CV[k] * max(proj, 1)) ** 2) / (n + 4))
        p_over = 1 - PHI((line - proj) / sd)
    return {"proj": round(proj, 1), "p_over": p_over, "n": n, "avg": round(sum(vals) / n, 1)}


def team_probs(g):
    """Margen y probabilidad del local con nuestros 4 modelos (sin Vegas) + total pronosticado."""
    ms = [m for m in g["pred"]["models"] if m["key"] != "vegas"]
    tw = sum(m["weight"] for m in ms) or 1
    m = sum(m["weight"] * m["margin"] for m in ms) / tw
    return m, PHI(m / SIGMA_M), g["pred"]["total"]


# ---------------------------------------------------------- recomendaciones ---

def game_recs(g, mk, hist, dfn, lg, props, players_names, out_inj):
    recs = []
    H, A = g["home"]["abbr"], g["away"]["abbr"]
    gname = f"{A} @ {H}"
    base = {"gid": g["id"], "week": g["key"], "game": gname, "date": g["date"]}
    m, ph, T = team_probs(g)
    if mk and ENABLED["ml"]:
        for side, p, o in (("home", ph, mk.get("ml_h")), ("away", 1 - ph, mk.get("ml_a"))):
            if o is None:
                continue
            p = implied(o) + CAL["ml"] * (p - implied(o))
            ev = p * dec(o) - 1
            team = H if side == "home" else A
            if ev >= MIN_EV["ml"] and p >= MIN_P_ML:
                recs.append({**base, "id": f"{g['id']}|ml|{team}", "kind": "ml", "pick": team, "side": side,
                             "label": f"{team} gana", "line": None, "odds": o, "p": p, "ev": ev})
    if mk and ENABLED["sp"] and mk.get("sp_h") is not None:
            pc = PHI((m + mk["sp_h"]) / SIGMA_M)          # local cubre el spread
            for side, p, o, v in (("home", pc, mk.get("sp_h_o"), mk["sp_h"]), ("away", 1 - pc, mk.get("sp_a_o"), -mk["sp_h"])):
                if o is None:
                    continue
                p = implied(o) + CAL["sp"] * (p - implied(o))
                ev = p * dec(o) - 1
                team = H if side == "home" else A
                if ev >= MIN_EV["sp"]:
                    recs.append({**base, "id": f"{g['id']}|sp|{team}", "kind": "sp", "pick": team, "side": side,
                                 "label": f"{team} {v:+g}", "line": v, "odds": o, "p": p, "ev": ev})
    if mk and ENABLED["tot"] and mk.get("tot") is not None:
            po = 1 - PHI((mk["tot"] - T) / SIGMA_T)
            for side, p, o in (("over", po, mk.get("ov_o")), ("under", 1 - po, mk.get("un_o"))):
                if o is None:
                    continue
                p = implied(o) + CAL["tot"] * (p - implied(o))
                ev = p * dec(o) - 1
                if ev >= MIN_EV["tot"]:
                    recs.append({**base, "id": f"{g['id']}|tot|{side}", "kind": "tot", "pick": side, "side": side,
                                 "label": f"{'Más' if side == 'over' else 'Menos'} de {mk['tot']:g} pts", "line": mk["tot"],
                                 "odds": o, "p": p, "ev": ev, "proj": round(T, 1)})
    pr = (props or {}).get("props") or {}
    for aid, lines in pr.items():
        info = players_names.get(aid)
        if not info or info["n"] in out_inj:
            continue
        team = info["t"]
        if team not in (H, A):
            continue
        opp = A if team == H else H
        for k, line in lines.items():
            if k not in PROP_SIDES or line < MIN_LINE.get(k, 0):
                continue
            r = project_prop(hist, dfn, lg, aid, k, line, opp)
            if not r:
                continue
            for side, p in (("over", r["p_over"]), ("under", 1 - r["p_over"])):
                if side not in PROP_SIDES[k]:
                    continue
                p = implied(PROP_ODDS) + CAL["prop"] * (p - implied(PROP_ODDS))
                ev = p * dec(PROP_ODDS) - 1
                if ev >= MIN_EV["prop"] and p <= MAX_P_PROP:
                    recs.append({**base, "id": f"{g['id']}|prop|{aid}|{k}|{side}", "kind": "prop", "aid": aid,
                                 "player": info["n"], "team": team, "pkey": k, "side": side, "line": line,
                                 "label": f"{info['n']} {'más' if side == 'over' else 'menos'} de {line:g} {PROP_NAMES[k]}",
                                 "odds": PROP_ODDS, "p": p, "ev": ev, "proj": r["proj"], "avg": r["avg"], "n": r["n"]})
    for r in recs:
        r["p"], r["ev"], r["stars"] = round(r["p"], 3), round(r["ev"], 3), stars(r["ev"])
    return recs


def td_candidates(g, hist, dfn, lg, props, players_names, out_inj):
    """Probabilidad de anotar TD (corriendo o recibiendo) de los jugadores con linea de 'Anytime TD'."""
    H, A = g["home"]["abbr"], g["away"]["abbr"]
    out = []
    for aid in ((props or {}).get("atd") or []):
        info = players_names.get(aid)
        if not info or info["n"] in out_inj or info["t"] not in (H, A):
            continue
        gs = [p for p in hist.get(aid, []) if p.get("ra", 0) or p.get("tgt", 0) or p.get("rec", 0)][-8:]
        if len(gs) < MIN_GAMES:
            continue
        tds = sum(p.get("rtd", 0) + p.get("rectd", 0) for p in gs)
        lam = TD_SCALE * (tds + 0.3) / (len(gs) + 1)
        opp = A if info["t"] == H else H
        d = dfn.get(opp)
        if d and lg.get("td"):
            lam *= (((d["rtd"] + d["rectd"]) + 2 * lg["td"]) / (d["g"] + 2) / lg["td"]) ** 0.5
        out.append({"gid": g["id"], "aid": aid, "player": info["n"], "team": info["t"], "game": f"{A} @ {H}",
                    "p": round(1 - math.exp(-lam), 3), "tds": int(tds), "n": len(gs)})
    return out


def make_parlays(recs, week):
    """Parlays de partidos distintos: el de mas valor de 2 y 3 selecciones, uno de jugadores y uno conservador."""
    def combo(legs):
        p = math.prod(l["p"] for l in legs)
        d = math.prod(dec(l["odds"]) for l in legs)
        return {"legs": [l["id"] for l in legs], "p": round(p, 3), "dec": round(d, 2), "ev": round(p * d - 1, 3)}

    def best(pool, n):
        pool = sorted(pool, key=lambda r: -r["ev"])[:12]
        cands = [c for c in combinations(pool, n) if len({l["gid"] for l in c}) == n]
        return max((combo(c) for c in cands), key=lambda c: c["ev"], default=None)

    team = [r for r in recs if r["kind"] != "prop"]
    props = [r for r in recs if r["kind"] == "prop"]
    out = []
    for name, pool, n in (("Valor: 2 selecciones", recs, 2), ("Valor: 3 selecciones", recs, 3),
                          ("Equipos: 2 selecciones", team, 2), ("Jugadores: 3 props", props, 3)):
        c = best(pool, n)
        if c and not any(x["legs"] == c["legs"] for x in out):
            out.append({"name": name, "week": week, **c})
    return out


def favorites_parlay(week_games, market, week):
    """Parlay conservador: los 3 favoritos mas claros segun Vegas (no tiene valor; es para quien quiere mas probabilidad)."""
    legs = []
    for g in week_games:
        mk = market.get(g["id"])
        if not mk or mk.get("ml_h") is None:
            continue
        ph = mk.get("p_h") or 0.5
        H, A = g["home"]["abbr"], g["away"]["abbr"]
        side, p, o, team = ("home", ph, mk["ml_h"], H) if ph >= 0.5 else ("away", 1 - ph, mk["ml_a"], A)
        legs.append({"id": f"{g['id']}|ml|{team}", "gid": g["id"], "week": g["key"], "game": f"{A} @ {H}", "date": g["date"],
                     "kind": "ml", "pick": team, "side": side, "label": f"{team} gana", "line": None, "odds": o,
                     "p": round(p, 3), "ev": round(p * dec(o) - 1, 3), "stars": 0})
    legs = sorted(legs, key=lambda l: -l["p"])[:3]
    if len(legs) < 3:
        return None, []
    p = math.prod(l["p"] for l in legs)
    d = math.prod(dec(l["odds"]) for l in legs)
    return {"name": "Conservador: 3 favoritos", "week": week, "legs": [l["id"] for l in legs],
            "p": round(p, 3), "dec": round(d, 2), "ev": round(p * d - 1, 3)}, legs


# ------------------------------------------------------------ calificar ---

def grade(rec, g, players):
    """'W' gano, 'L' perdio, 'P' empate/anulada, None pendiente."""
    if not g or not g["final"]:
        return None
    H = g["home"]["abbr"]
    hm = g["hs"] - g["as"]
    if rec["kind"] == "ml":
        if hm == 0:
            return "P"
        return "W" if (hm > 0) == (rec["pick"] == H) else "L"
    if rec["kind"] == "sp":
        v = hm + rec["line"] if rec["side"] == "home" else -hm + rec["line"]
        return "P" if v == 0 else "W" if v > 0 else "L"
    if rec["kind"] == "tot":
        t = g["hs"] + g["as"]
        if t == rec["line"]:
            return "P"
        return "W" if (t > rec["line"]) == (rec["side"] == "over") else "L"
    if rec["kind"] == "prop":
        p = (players.get(g["id"]) or {}).get(rec["aid"])
        if not p:
            return "P"                                    # no jugo: apuesta anulada
        v = p.get(rec["pkey"], 0)
        if v == rec["line"]:
            return "P"
        return "W" if (v > rec["line"]) == (rec["side"] == "over") else "L"
    return None


def profit(res, odds):
    return dec(odds) - 1 if res == "W" else -1 if res == "L" else 0


def summarize(items):
    s = {"n": 0, "w": 0, "l": 0, "p": 0, "units": 0.0}
    for res, odds in items:
        if res is None:
            continue
        s["n"] += 1
        s["w" if res == "W" else "l" if res == "L" else "p"] += 1
        s["units"] += profit(res, odds)
    s["units"] = round(s["units"], 2)
    staked = s["w"] + s["l"]
    s["roi"] = round(s["units"] / staked, 3) if staked else None
    return s


# ------------------------------------------------------------------ main ---

def build(season, games, weeks_out, market, extras, current, H, first_week=3):
    players = fetch_players(season, games, H)
    cur_games = [g for g in games if g["key"] == current]
    props = fetch_props(season, [g for g in games if g["final"] or g in cur_games], H)
    names = {}
    for pl in players.values():
        for aid, p in pl.items():
            names[aid] = {"n": p["n"], "t": p["t"]}       # el mas reciente gana (cambios de equipo)
    frozen_path = os.path.join(H["cache_dir"], f"recs_{season}.json")
    frozen = H["load_json"](frozen_path, {})              # recomendaciones guardadas antes de cada partido
    by_id = {g["id"]: g for g in games}
    weeks = {}
    hist_items = defaultdict(list)
    for w in weeks_out:
        k = w["key"]
        if k < first_week or k > current:
            continue
        hist, dfn, lg = history_before(games, players, k)
        recs, tds, fav_legs_all = [], [], []
        for g in w["games"]:
            ex = extras.get(g["id"]) or {}
            out_inj = {p["name"] for lst in (ex.get("injuries") or {}).values() for p in lst if p["status"] in ("Out", "Doubtful")}
            if g["id"] in frozen and g["state"] != "pre":
                gr = frozen[g["id"]]["recs"]                  # la que se hizo antes del partido
                for r in gr:
                    r["src"] = "real"
            else:
                gr = game_recs(g, market.get(g["id"]), hist, dfn, lg, props.get(g["id"]), names, out_inj)
                for r in gr:
                    r["src"] = "sim" if g["final"] else "live"
                if g["state"] == "pre":
                    frozen[g["id"]] = {"recs": gr}
            recs += gr
            tds += td_candidates(g, hist, dfn, lg, props.get(g["id"]), names, out_inj)
        parlays = make_parlays(recs, k)
        fav, fav_legs = favorites_parlay(w["games"], market, k)
        if fav:
            parlays.append(fav)
        legs_by_id = {r["id"]: r for r in recs + fav_legs}
        for r in recs:
            r["res"] = grade(r, by_id.get(r["gid"]), players)
            hist_items[(r["src"] if r["src"] != "live" else "real", r["kind"])].append((r["res"], r["odds"]))
        for pz in parlays:
            legs = [legs_by_id[i] for i in pz["legs"] if i in legs_by_id]
            for l in legs:
                if "res" not in l:
                    l["res"] = grade(l, by_id.get(l["gid"]), players)
            rs = [l["res"] for l in legs]
            pz["res"] = None if None in rs else "L" if "L" in rs else "P" if all(r == "P" for r in rs) else "W"
            pz["leg_info"] = [{"id": l["id"], "label": l["label"], "game": l["game"], "odds": l["odds"], "p": l["p"], "res": l["res"]} for l in legs]
            src = "sim" if any(by_id.get(l["gid"], {}).get("final") and l.get("src", "sim") == "sim" for l in legs) else "real"
            hist_items[(src, "parlay")].append((pz["res"], _american(pz["dec"])))
        for t in tds:
            gg = by_id.get(t["gid"])
            if gg and gg["final"]:
                p = (players.get(t["gid"]) or {}).get(t["aid"])
                t["res"] = None if p is None else ("W" if (p.get("rtd", 0) + p.get("rectd", 0)) > 0 else "L")
        weeks[k] = {"recs": sorted(recs, key=lambda r: -r["ev"]), "parlays": parlays,
                    "td": sorted(tds, key=lambda t: -t["p"])[:15]}
    H["save_json"](frozen_path, frozen)
    history = {f"{src}|{kind}": summarize(v) for (src, kind), v in hist_items.items()}
    return {"weeks": weeks, "history": history,
            "params": {"min_ev": MIN_EV, "prop_odds": PROP_ODDS, "min_games": MIN_GAMES}}


def _american(d):
    return round((d - 1) * 100) if d >= 2 else round(-100 / (d - 1))
