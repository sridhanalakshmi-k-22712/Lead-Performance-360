/* ==========================================================================
   Lead Performance 360 — Zoho CRM widget
   --------------------------------------------------------------------------
   Contents
     1. Config, palette & view state
     2. Time helpers (YTD axis — auto-extends as months pass)
     3. Formatting
     4. Data layer  <-- WIRE ZOHO ANALYTICS HERE (§ 4.2)
     5. Chart engine (hand-rolled SVG: no CDN, CSP-safe inside CRM)
        5.1 primitives   5.2 dispatcher    5.3 overlay    5.4 small multiples
        5.5 interaction (hover · brush-zoom · drill)      5.6 tooltip
     6. Renderers — tiles, meters, cards, tables, sections
     7. Drill-through panel
     8. Boot & Zoho embedded-app wiring

   Charting rules this file holds itself to:
     · one y-scale per plot — never a dual axis. Revenue/Customers/Leads have
       incompatible units, so § 6.6 renders them as SMALL MULTIPLES, not as
       three lines sharing one axis.
     · categorical hues assigned by entity, never by rank — muting a series
       never repaints the survivors.
     · every 2+ series plot has a legend; every plot has a table view.
     · analysis overlays (compare / target / trend) are secondary ink: thinner,
       dashed, and behind the actuals. They never outweigh the data.
   ========================================================================== */

(function () {
  "use strict";

  /* ======================================================================
     1. Config, palette & view state
     ====================================================================== */

  var CONFIG = {
    /* Overridden from the org profile on boot when the SDK is available. */
    currency: "$",

    /* How many past years the Year filter offers. */
    yearsBack: 3,

    /* Region / BU filter values. Replace these with your own dimension
       members — ideally read them from the Analytics dimension or the CRM
       picklist so the list cannot drift out of sync with the data. */
    regions: ["North America", "EMEA", "APAC", "India", "LATAM"],
    businessUnits: ["Enterprise", "Mid-Market", "SMB", "Public Sector"],
    services: ["Implementation", "Support", "Consulting", "Training",
               "Managed Services"],

    /* How to tell a BU head from a manager from a rep. Every org names its
       roles differently, so list YOUR CRM role names here and they win. Leave
       them empty and the tiers are derived from the reporting tree instead:
       no direct reports is a rep, reports who are all individuals is a
       manager, and at least one report who manages people is a BU head. */
    hierarchy: {
      buHeadRoles:  [],
      managerRoles: [],
      repRoles:     []
    },

    /* Set false once CONFIG.analytics below is filled in. */
    useMockData: true,

    /* ---- Zoho Analytics, reached through a CRM Connection --------------
       No credential lives here or anywhere else in this file: CRM holds the
       token and proxies the call. Create the connection under
       Setup > Developer Hub > Connections with scope ZohoAnalytics.data.read.

       `columns` maps what the dashboard needs (left) to the column names in
       your Analytics view (right). Change the RIGHT side only. Set any
       measure you do not have to null and it renders blank instead of wrong.
       The view contract is documented in § 4.2.
    -------------------------------------------------------------------- */
    analytics: {
      connectionName: "",          // e.g. "zoho_analytics"
      orgId:          "",          // ZANALYTICS-ORGID
      workspaceId:    "",
      viewId:         "",
      dc:             "com",       // com | in | eu | com.au — your Analytics DC

      columns: {
        /* dimensions */
        year:                   "Year",
        month:                  "Month",          // 1-12
        region:                 "Region",
        bu:                     "BU",
        service:                "Service",
        ownerEmail:             "Owner_Email",    // drives the user scoping

        /* scorecard */
        newProspects:           "New_Prospects",
        csProspects:            "CS_Prospects",
        newCustomers:           "New_Customers",
        csCustomers:            "CS_Customers",
        under5kCustomers:       "Under_5K_Customers",
        over5kCustomers:        "Over_5K_Customers",
        newRevenue:             "New_Revenue",
        csRevenue:              "CS_Revenue",
        leads:                  "Leads",

        /* bookings + closures */
        bookedCustomers:        "Booked_Customers",
        churnedCustomers:       "Churned_Customers",
        pseRate:                "PSE_Rate",
        revenueRate:            "Revenue_Rate",
        customerRate:           "Customer_Rate",

        /* channel mix */
        guidedCustomers:        "Guided_Customers",
        selfServeCustomers:     "SelfService_Customers",
        guidedRevenue:          "Guided_Revenue",
        selfServeRevenue:       "SelfService_Revenue",

        /* pipeline & loss — snapshots, read from the latest month */
        qualifiedLostCustomers: "Qualified_Lost_Customers",
        lostRevenue:            "Lost_Revenue",
        pipelineRevenueQuarter: "Pipeline_Revenue_Quarter",
        pipelineRevenueYear:    "Pipeline_Revenue_Year",
        pipelineOverdue:        "Pipeline_Overdue",
        forecastRevenue:        "Forecast_Revenue",
        attainedRevenue:        "Attained_Revenue",

        /* quotas — null these if you have no target columns */
        targetRevenue:          "Target_Revenue",
        targetCustomers:        "Target_Customers",
        targetPseRate:          "Target_PSE_Rate"
      }
    },

    /* Drill-through: fetch the records behind a point. Falls back to sample
       rows whenever the CRM API is unavailable (e.g. opened standalone). */
    enableDrill: true,

    /* Rows to pull per drill-through. */
    drillLimit: 8
  };

  /**
   * Entity -> categorical slot. Colour follows the ENTITY, never its rank in
   * the series list, so muting one series never repaints the rest.
   *
   * Only slots 1-3 are used: {blue, orange, aqua} is validated all-pairs on
   * the white card surface (worst CVD dE 10.5, normal-vision dE 22.1).
   * Slot 4 (violet) is deliberately NOT used beside slot 1 (blue) — that pair
   * measures dE 2.1 under deuteranopia and is indistinguishable.
   */
  var HUE = {
    revenue:     "--series-1",
    customers:   "--series-2",
    leads:       "--series-3",
    booked:      "--series-1",
    churned:     "--series-2",
    pse:         "--series-3",
    guided:      "--series-1",
    selfService: "--series-2"
  };

  /**
   * View state — what the analysis toggles and the brush are showing.
   * `range` is a window into the FULL month axis, so zoom survives a
   * re-render and stays linked across every month-based chart.
   */
  var VIEW = {
    compare: false,   // prior-year ghost line
    target:  false,   // quota reference line + shortfall wash
    trend:   false,   // least-squares fit over the visible window
    range:   null     // [startIndex, endIndex] into the full month axis
  };

  function cssVar(name) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(name).trim() || "#888";
  }

  /**
   * Who is looking. Populated from the CRM session inside the widget, and
   * left null when opened standalone. The Scope filter resolves against
   * this, so "My records" means whoever is signed in — not a hardcoded id.
   */
  var CRM = {
    user: null,
    teamEmails: [],
    /* The reporting tree behind the BU Head / Manager / Rep filters. Built
       from CRM users inside the widget, synthesised outside it. */
    people: { byId: {}, children: {}, buHeads: [], managers: [], reps: [] }
  };

  /**
   * Index the reporting tree and sort everyone into a tier. Role names from
   * CONFIG.hierarchy win when supplied; otherwise the tiers come from the
   * shape of the tree, which is the only thing we can rely on in an org whose
   * role names we do not know.
   */
  function buildHierarchy(users) {
    var P = CRM.people;
    P.byId = {}; P.children = {}; P.buHeads = []; P.managers = []; P.reps = [];

    users.forEach(function (u) { P.byId[u.id] = u; });
    Object.keys(P.byId).forEach(function (id) {
      var m = P.byId[id].managerId;
      if (m && P.byId[m]) (P.children[m] || (P.children[m] = [])).push(id);
    });

    var H = CONFIG.hierarchy || {};
    var configured = (H.buHeadRoles || []).length || (H.managerRoles || []).length ||
                     (H.repRoles || []).length;
    var hasRole = function (list, role) {
      return (list || []).some(function (r) {
        return role && r.toLowerCase() === String(role).toLowerCase();
      });
    };

    Object.keys(P.byId).forEach(function (id) {
      var p = P.byId[id];

      if (configured) {
        if (hasRole(H.buHeadRoles, p.role)) P.buHeads.push(id);
        else if (hasRole(H.managerRoles, p.role)) P.managers.push(id);
        else if (hasRole(H.repRoles, p.role)) P.reps.push(id);
        return;
      }

      var reports = P.children[id] || [];
      if (!reports.length) { P.reps.push(id); return; }

      /* A front-line manager's reports are all individuals; a BU head has at
         least one report who manages people of their own. Keying off "manages
         managers" rather than "sits at the top of the tree" keeps front-line
         managers out of the BU-head list even when they report straight to
         the top. */
      var managesManagers = reports.some(function (r) {
        return (P.children[r] || []).length > 0;
      });
      if (managesManagers) P.buHeads.push(id);
      else P.managers.push(id);
    });

    var byName = function (a, b) {
      return (P.byId[a].name || "").localeCompare(P.byId[b].name || "");
    };
    P.buHeads.sort(byName); P.managers.sort(byName); P.reps.sort(byName);
  }

  /** Everyone at or beneath one person. */
  function subtreeIds(id) {
    var out = [], stack = [id];
    while (stack.length) {
      var cur = stack.pop();
      out.push(cur);
      (CRM.people.children[cur] || []).forEach(function (c) { stack.push(c); });
    }
    return out;
  }

  function emailsUnder(id) {
    return subtreeIds(id).map(function (i) {
      return CRM.people.byId[i] && CRM.people.byId[i].email;
    }).filter(Boolean);
  }

  /**
   * Which record owners the current selection implies, or null for "no
   * owner constraint at all".
   *
   * The most specific person wins — rep, then manager, then BU head, then the
   * Scope filter. Intersecting them instead would let two people-filters
   * silently produce an empty set that looks like "no business".
   */
  function resolveOwnerEmails(f) {
    /* union, de-duplicated: two selected managers may share a report */
    var union = function (ids) {
      var out = [];
      ids.forEach(function (id) {
        emailsUnder(id).forEach(function (e) {
          if (out.indexOf(e) === -1) out.push(e);
        });
      });
      return out;
    };

    if ((f.rep || []).length) return union(f.rep);
    if ((f.manager || []).length) return union(f.manager);
    if ((f.buHead || []).length) return union(f.buHead);
    if (f.scope === "mine" && CRM.user && CRM.user.email) return [CRM.user.email];
    if (f.scope === "team" && CRM.teamEmails.length) return CRM.teamEmails.slice();
    return null;
  }

  /** The label for whichever person the selection has narrowed to. */
  function selectedPeopleLabel(f) {
    var tier = (f.rep || []).length ? { ids: f.rep, noun: "reps" }
             : (f.manager || []).length ? { ids: f.manager, noun: "managers" }
             : (f.buHead || []).length ? { ids: f.buHead, noun: "BU heads" }
             : null;
    if (!tier) return null;

    if (tier.ids.length === 1) {
      var p = CRM.people.byId[tier.ids[0]];
      return p ? p.name : null;
    }
    return tier.ids.length + " " + tier.noun;
  }

  /** The signed-in CRM user. Resolves to null rather than throwing. */
  function loadCurrentUser() {
    if (!window.ZOHO || !ZOHO.CRM || !ZOHO.CRM.CONFIG ||
        !ZOHO.CRM.CONFIG.getCurrentUser) return Promise.resolve(null);

    return ZOHO.CRM.CONFIG.getCurrentUser().then(function (r) {
      var u = r && r.users && r.users[0];
      if (!u) return null;
      CRM.user = {
        id: u.id,
        name: u.full_name || u.name,
        email: u.email,
        role: u.role && u.role.name,
        profile: u.profile && u.profile.name
      };
      return CRM.user;
    }).catch(function () { return null; });
  }


  /**
   * A CRM widget always runs in an iframe, and its host component supplies
   * its own padding and title bar. Flag that up front — before first paint —
   * so the dashboard renders at the embedded density immediately rather than
   * reflowing once the SDK reports in.
   */
  (function detectEmbedded() {
    var framed;
    try {
      framed = window.self !== window.top;
    } catch (e) {
      framed = true;          // cross-origin check threw: definitely framed
    }
    if (framed) document.documentElement.classList.add("lp-embedded");
  })();

  /* ======================================================================
     2. Time helpers
     ====================================================================== */

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  var QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

  /**
   * The YTD month axis. For the current year this is Jan -> the current month;
   * for any past year it is the full Jan -> Dec. Nothing is hard-coded, so the
   * axis grows on its own as each new month begins.
   */
  function ytdMonths(year) {
    var now = new Date();
    var last = (year === now.getFullYear()) ? now.getMonth() : 11;
    return MONTHS.slice(0, last + 1);
  }

  function currentQuarter() {
    return Math.floor(new Date().getMonth() / 3) + 1;
  }

  function periodLabel(year) {
    var months = ytdMonths(year);
    return "Jan – " + months[months.length - 1] + " " + year + "  ·  year to date";
  }

  /** The brush window, clamped to the months that actually exist. */
  function windowFor(year) {
    var all = ytdMonths(year);
    if (!VIEW.range) return { start: 0, end: all.length - 1, all: all };
    var s = Math.max(0, Math.min(all.length - 1, VIEW.range[0]));
    var e = Math.max(s, Math.min(all.length - 1, VIEW.range[1]));
    return { start: s, end: e, all: all };
  }

  /* ======================================================================
     3. Formatting
     ====================================================================== */

  function fmtCount(v) {
    if (v == null || !isFinite(v)) return "–";
    if (Math.abs(v) >= 1e6) return trim(v / 1e6) + "M";
    if (Math.abs(v) >= 10000) return trim(v / 1e3) + "K";
    return Math.round(v).toLocaleString("en-US");
  }

  function fmtCurrency(v) {
    if (v == null || !isFinite(v)) return "–";
    var sign = v < 0 ? "-" : "";
    var a = Math.abs(v);
    if (a >= 1e6) return sign + CONFIG.currency + trim(a / 1e6) + "M";
    if (a >= 1e3) return sign + CONFIG.currency + trim(a / 1e3) + "K";
    return sign + CONFIG.currency + Math.round(a).toLocaleString("en-US");
  }

  function fmtPercent(v) {
    if (v == null || !isFinite(v)) return "–";
    return (Math.round(v * 10) / 10) + "%";
  }

  function fmtSignedPct(v) {
    if (v == null || !isFinite(v)) return null;
    var r = Math.round(v * 10) / 10;
    return (r > 0 ? "+" : "") + r + "%";
  }

  function trim(n) {
    var r = Math.round(n * 10) / 10;
    return (r % 1 === 0 ? r.toFixed(0) : r.toFixed(1));
  }

  function formatter(kind) {
    if (kind === "currency") return fmtCurrency;
    if (kind === "percent") return fmtPercent;
    return fmtCount;
  }

  /* ======================================================================
     4. Data layer
     ====================================================================== */

  /* ---- 4.1 The shape every renderer expects ---------------------------
     Return exactly this from § 4.2 and the whole dashboard lights up.
     Every `months`-keyed array must be parallel to `ytdMonths(year)`; short
     arrays are padded with null (a null breaks the line rather than
     plotting a zero), long ones are truncated.

     {
       year, scope,
       ytd:  { newProspects, csProspects, newCustomers, csCustomers,
               totalCustomers, convPct, under5kCustomers, over5kCustomers,
               newRevenue, csRevenue, totalRevenue },
       prev: { ...same keys, prior-year same-period, drives the tile deltas },

       monthly:   { revenue:[], customers:[], leads:[] },
       quarterly: { revenue:[], customers:[], leads:[] },      // 4 entries

       // Prior-year actuals for the SAME periods — drives "compare".
       // Omit any branch you have no history for; its ghost line is skipped.
       lastYear: {
         monthly:   { revenue:[], customers:[], leads:[] },
         quarterly: { revenue:[], customers:[], leads:[] },
         bookings:  { booked:[], churned:[] },
         pse:       { pse:[], revenue:[], customers:[] },
         channel:   { guidedCustomers:[], selfServeCustomers:[],
                      guidedRevenue:[], selfServeRevenue:[] }
       },

       // Quota per period. A number applies to every period; an array is
       // per-period. Omit a key to draw no target line for that series.
       targets: {
         monthlyRevenue:   [] | number,
         monthlyCustomers: [] | number,
         quarterlyRevenue: [] | number,
         pseClosureRate:   number
       },

       pipeline:  { qualifiedLostCustomers, lostRevenue,
                    pipelineRevenueQuarter, pipelineRevenueYear,
                    pipelineOverdue,      // open pipeline past its close date
                    forecastRevenue, attainedRevenue },
       bookings:  { booked:[], churned:[] },
       pse:       { pse:[], revenue:[], customers:[] },        // percentages
       channel:   { guidedCustomers:[], selfServeCustomers:[],
                    guidedRevenue:[],  selfServeRevenue:[] }
     }
  ------------------------------------------------------------------------ */

  /* ---- 4.2 Zoho Analytics adapter --------------------------------------

     The widget never holds a credential. It calls a CRM Connection by name;
     CRM stores and refreshes the Analytics token server-side and proxies the
     request. Set one up in Setup > Developer Hub > Connections with the
     scope ZohoAnalytics.data.read, then fill in CONFIG.analytics below.

     THE VIEW CONTRACT
     Point this at ONE Analytics view (a table or query table) that returns
     one row per month per dimension combination:

         Year | Month | Region | BU | Owner_Email | <measures...>

     Month is 1-12. Everything the dashboard shows is derived from those
     rows client-side: the monthly series is the rows in month order, the
     quarterly series sums them 3 at a time, the YTD tiles sum them all, and
     the prior-year comparison is the same query run for year - 1.

     The pipeline measures are point-in-time rather than additive, so they
     are read from the LATEST month in the result rather than summed.

     Any measure you have no column for: leave its entry as null in
     CONFIG.analytics.columns. That metric then renders blank rather than
     wrong — a gap in a line, a dash in a tile.
  ---------------------------------------------------------------------- */

  /**
   * Criteria for the Analytics query. "all" means the dimension is not
   * constrained, so it contributes no clause at all rather than a clause
   * matching the literal string "all".
   *
   * Scope is resolved against the signed-in CRM user rather than a literal:
   * "mine" filters to their own email, so what a person sees follows who
   * they are logged in as.
   */
  function buildCriteria(f, yearOverride) {
    var col = CONFIG.analytics.columns;
    var q = function (name, value) {
      return '"' + name + '" = \'' + String(value).replace(/'/g, "\\'") + "'";
    };

    var year = yearOverride != null ? yearOverride : f.year;
    var parts = ['"' + col.year + '" = ' + Number(year)];

    /* Flat dimensions. Values within one dimension are alternatives (OR);
       separate dimensions narrow each other (AND). */
    [["region", col.region], ["bu", col.bu], ["service", col.service]]
      .forEach(function (pair) {
        var vals = f[pair[0]] || [];
        if (!vals.length || !pair[1]) return;
        parts.push("(" + vals.map(function (v) {
          return q(pair[1], v);
        }).join(" or ") + ")");
      });

    /* people, collapsed to a single owner set (see resolveOwnerEmails) */
    var owners = resolveOwnerEmails(f);
    if (owners && owners.length && col.ownerEmail) {
      parts.push("(" + owners.map(function (e) {
        return q(col.ownerEmail, e);
      }).join(" or ") + ")");
    }

    return parts.join(" and ");
  }

  /** True once every required id is filled in. */
  function analyticsConfigured() {
    var a = CONFIG.analytics;
    return !!(a.connectionName && a.orgId && a.workspaceId && a.viewId);
  }

  /**
   * One Analytics call through the CRM Connection. Returns the raw row
   * array. Analytics nests its payload differently depending on the
   * connection response shape, so unwrap defensively rather than assuming
   * one path and failing opaquely.
   */
  function invokeAnalytics(criteria) {
    var a = CONFIG.analytics;

    return ZOHO.CRM.CONNECTION.invoke(a.connectionName, {
      url: "https://analyticsapi.zoho." + a.dc +
           "/restapi/v2/workspaces/" + a.workspaceId +
           "/views/" + a.viewId + "/data",
      method: "GET",
      param_type: 1,
      parameters: {
        CONFIG: JSON.stringify({
          criteria: criteria,
          responseFormat: "json"
        })
      },
      headers: { "ZANALYTICS-ORGID": a.orgId }
    }).then(function (res) {
      var body = res && res.details && res.details.statusMessage;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch (e) { /* leave as-is */ }
      }
      var rows = body && (
        (body.data && body.data.rows) ||
        body.data ||
        (body.response && body.response.result && body.response.result.rows)
      );
      if (!rows) {
        throw new Error("Unexpected Analytics response — check the view id " +
                        "and that the connection has ZohoAnalytics.data.read");
      }
      return rows;
    });
  }

  /**
   * Analytics rows -> the § 4.1 shape.
   *
   * Rows may arrive in any order and may skip months entirely (a month with
   * no activity simply has no row). Indexing by month rather than pushing in
   * arrival order means a missing month stays null — a gap — instead of
   * silently shifting every later month one slot to the left.
   */
  function mapAnalyticsRows(rows, year, prevRows) {
    var col = CONFIG.analytics.columns;
    var months = ytdMonths(year);
    var n = months.length;

    var num = function (v) {
      if (v == null || v === "") return null;
      var f = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
      return isFinite(f) ? f : null;
    };

    /** Bucket a row set into a 12-slot array per measure. */
    function bucket(src) {
      var by = {};
      (src || []).forEach(function (r) {
        var m = parseInt(r[col.month], 10);
        if (!(m >= 1 && m <= 12)) return;
        var slot = by[m - 1] || (by[m - 1] = {});
        Object.keys(col).forEach(function (key) {
          var name = col[key];
          if (!name || r[name] === undefined) return;
          var v = num(r[name]);
          if (v == null) return;
          /* several owners/regions can share a month — additive measures
             accumulate, point-in-time ones take the latest value */
          slot[key] = POINT_IN_TIME[key] ? v : (slot[key] || 0) + v;
        });
      });
      return by;
    }

    var cur = bucket(rows);
    var prv = bucket(prevRows);

    /** Measure -> a month-indexed array over the YTD axis. */
    function series(src, key) {
      var out = [];
      for (var i = 0; i < n; i++) {
        out.push(src[i] && src[i][key] != null ? src[i][key] : null);
      }
      return out;
    }

    var sum = function (arr) {
      var t = null;
      arr.forEach(function (v) { if (v != null) t = (t || 0) + v; });
      return t;
    };

    /** Latest non-null value — for the point-in-time pipeline measures. */
    var latest = function (arr) {
      for (var i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
      return null;
    };

    /** Months summed three at a time; a quarter with no data stays null. */
    function quarterly(arr) {
      var out = [];
      for (var q = 0; q < 4; q++) {
        var slice = arr.slice(q * 3, q * 3 + 3).filter(function (v) { return v != null; });
        out.push(slice.length ? slice.reduce(function (a, b) { return a + b; }, 0) : null);
      }
      return out;
    }

    var M = {};
    Object.keys(col).forEach(function (key) { M[key] = series(cur, key); });
    var P = {};
    Object.keys(col).forEach(function (key) { P[key] = series(prv, key); });

    var newCustomers = sum(M.newCustomers);
    var csCustomers  = sum(M.csCustomers);
    var newRevenue   = sum(M.newRevenue);
    var csRevenue    = sum(M.csRevenue);
    var newProspects = sum(M.newProspects);
    var csProspects  = sum(M.csProspects);

    var totalCustomers = (newCustomers || 0) + (csCustomers || 0);
    var totalProspects = (newProspects || 0) + (csProspects || 0);

    /* revenue is the sum of its two parts; leads drive the conversion rate */
    var monthlyRevenue = M.newRevenue.map(function (v, i) {
      var c = M.csRevenue[i];
      return v == null && c == null ? null : (v || 0) + (c || 0);
    });
    var monthlyCustomers = M.newCustomers.map(function (v, i) {
      var c = M.csCustomers[i];
      return v == null && c == null ? null : (v || 0) + (c || 0);
    });

    return {
      year: year,
      scope: state.scope,

      ytd: {
        newProspects:     newProspects,
        csProspects:      csProspects,
        newCustomers:     newCustomers,
        csCustomers:      csCustomers,
        totalCustomers:   totalCustomers,
        convPct:          totalProspects ? (totalCustomers / totalProspects) * 100 : null,
        under5kCustomers: sum(M.under5kCustomers),
        over5kCustomers:  sum(M.over5kCustomers),
        newRevenue:       newRevenue,
        csRevenue:        csRevenue,
        totalRevenue:     (newRevenue || 0) + (csRevenue || 0)
      },

      prev: {
        newProspects:     sum(P.newProspects),
        csProspects:      sum(P.csProspects),
        newCustomers:     sum(P.newCustomers),
        csCustomers:      sum(P.csCustomers),
        totalCustomers:   (sum(P.newCustomers) || 0) + (sum(P.csCustomers) || 0),
        convPct:          null,
        under5kCustomers: sum(P.under5kCustomers),
        over5kCustomers:  sum(P.over5kCustomers),
        newRevenue:       sum(P.newRevenue),
        csRevenue:        sum(P.csRevenue),
        totalRevenue:     (sum(P.newRevenue) || 0) + (sum(P.csRevenue) || 0)
      },

      monthly: {
        revenue:   monthlyRevenue,
        customers: monthlyCustomers,
        leads:     M.leads
      },
      quarterly: {
        revenue:   quarterly(monthlyRevenue),
        customers: quarterly(monthlyCustomers),
        leads:     quarterly(M.leads)
      },

      lastYear: {
        monthly: {
          revenue: P.newRevenue.map(function (v, i) {
            var c = P.csRevenue[i];
            return v == null && c == null ? null : (v || 0) + (c || 0);
          }),
          customers: P.newCustomers.map(function (v, i) {
            var c = P.csCustomers[i];
            return v == null && c == null ? null : (v || 0) + (c || 0);
          }),
          leads: P.leads
        },
        bookings: { booked: P.bookedCustomers, churned: P.churnedCustomers },
        pse: { pse: P.pseRate, revenue: P.revenueRate, customers: P.customerRate },
        channel: {
          guidedCustomers:    P.guidedCustomers,
          selfServeCustomers: P.selfServeCustomers,
          guidedRevenue:      P.guidedRevenue,
          selfServeRevenue:   P.selfServeRevenue
        }
      },

      targets: {
        monthlyRevenue:   M.targetRevenue,
        monthlyCustomers: M.targetCustomers,
        quarterlyRevenue: quarterly(M.targetRevenue),
        pseClosureRate:   latest(M.targetPseRate)
      },

      pipeline: {
        qualifiedLostCustomers: sum(M.qualifiedLostCustomers),
        lostRevenue:            sum(M.lostRevenue),
        pipelineRevenueQuarter: latest(M.pipelineRevenueQuarter),
        pipelineRevenueYear:    latest(M.pipelineRevenueYear),
        pipelineOverdue:        latest(M.pipelineOverdue),
        forecastRevenue:        latest(M.forecastRevenue),
        attainedRevenue:        latest(M.attainedRevenue) != null
                                  ? latest(M.attainedRevenue)
                                  : (newRevenue || 0) + (csRevenue || 0)
      },
      prevPipeline: {
        qualifiedLostCustomers: sum(P.qualifiedLostCustomers),
        lostRevenue:            sum(P.lostRevenue)
      },

      bookings: { booked: M.bookedCustomers, churned: M.churnedCustomers },
      pse: { pse: M.pseRate, revenue: M.revenueRate, customers: M.customerRate },
      channel: {
        guidedCustomers:    M.guidedCustomers,
        selfServeCustomers: M.selfServeCustomers,
        guidedRevenue:      M.guidedRevenue,
        selfServeRevenue:   M.selfServeRevenue
      }
    };
  }

  /* Measures that are a snapshot, not a running total. Summing these across
     months would be meaningless, so they take the latest month's value. */
  var POINT_IN_TIME = {
    pipelineRevenueQuarter: true,
    pipelineRevenueYear:    true,
    pipelineOverdue:        true,
    forecastRevenue:        true,
    attainedRevenue:        true,
    targetRevenue:          true,
    targetCustomers:        true,
    targetPseRate:          true,
    pseRate:                true,
    revenueRate:            true,
    customerRate:           true
  };

  function fetchData(f) {
    if (CONFIG.useMockData) {
      return Promise.resolve(mockData(f));
    }

    if (!window.ZOHO || !ZOHO.CRM || !ZOHO.CRM.CONNECTION) {
      return Promise.reject(new Error(
        "Live data needs the CRM SDK — open this inside CRM, not standalone."
      ));
    }
    if (!analyticsConfigured()) {
      return Promise.reject(new Error(
        "Analytics is not configured — fill in CONFIG.analytics in script.js § 1."
      ));
    }

    /* prior year is fetched alongside so the deltas and the compare overlay
       have real history; if it fails we still render the current year */
    return Promise.all([
      invokeAnalytics(buildCriteria(f)),
      invokeAnalytics(buildCriteria(f, f.year - 1))
        .catch(function () { return []; })
    ]).then(function (both) {
      return mapAnalyticsRows(both[0], f.year, both[1]);
    });
  }

  /**
   * Align an incoming array to the axis: truncate if long, pad with null if
   * short. Nulls render as a gap, never as a zero.
   */
  function align(arr, len) {
    var out = [];
    for (var i = 0; i < len; i++) {
      var v = (arr && arr[i] != null && isFinite(arr[i])) ? Number(arr[i]) : null;
      out.push(v);
    }
    return out;
  }

  /** Slice an aligned array down to the brush window. */
  function slice(arr, win) {
    return arr ? arr.slice(win.start, win.end + 1) : null;
  }

  /** A quota that may be a scalar or a per-period array -> aligned array. */
  function targetArray(t, len) {
    if (t == null) return null;
    if (typeof t === "number") {
      var out = [];
      for (var i = 0; i < len; i++) out.push(t);
      return out;
    }
    return align(t, len);
  }

  /* ---- 4.3 Mock data ---------------------------------------------------
     Deterministic (seeded) so the dashboard looks identical on every reload
     and design changes are easy to eyeball. Delete once § 4.2 is live.
  ---------------------------------------------------------------------- */

  function seeded(seed) {
    var s = seed;
    return function () {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
  }

  function mockData(f) {
    var year = f.year;
    var scope = f.scope || "all";
    var region = f.region || [];
    var bu = f.bu || [];
    var service = f.service || [];

    var months = ytdMonths(year);
    var n = months.length;
    var seedOf = function (vals) { return vals.join("|").length; };
    var rnd = seeded(year * 977 + scope.length * 13 +
                     seedOf(region) * 101 + seedOf(bu) * 37 + seedOf(service) * 59);

    var mult = scope === "mine" ? 0.24 : scope === "team" ? 0.62 : 1;
    /* each selected dimension carves the org down to a slice of itself */
    /* each selected member contributes its share, so picking two regions
       reads larger than one and never larger than all of them */
    var share = function (vals, list, weights) {
      if (!vals.length) return 1;
      var t = 0;
      vals.forEach(function (v) { t += weights[list.indexOf(v)] || 0.15; });
      return Math.min(1, t);
    };
    mult *= share(region, CONFIG.regions, [0.34, 0.27, 0.19, 0.14, 0.06]);
    mult *= share(bu, CONFIG.businessUnits, [0.42, 0.3, 0.19, 0.09]);
    mult *= share(service, CONFIG.services, [0.31, 0.24, 0.2, 0.15, 0.1]);
    /* a people selection narrows in proportion to how much of the org it
       covers, so a rep reads smaller than their manager, who reads smaller
       than their BU head */
    var owners = resolveOwnerEmails(f);
    if (owners) {
      var total = Object.keys(CRM.people.byId).length || owners.length;
      mult *= Math.max(0.04, owners.length / total);
    }

    function series(base, growth, jitter) {
      var out = [];
      for (var i = 0; i < n; i++) {
        var v = base * (1 + growth * i) * (1 + (rnd() - 0.5) * jitter);
        out.push(Math.max(0, Math.round(v * mult)));
      }
      return out;
    }

    /* prior-year twin: same shape, scaled down, independently jittered */
    function ghost(arr, factor) {
      return arr.map(function (v, i) {
        return Math.max(0, Math.round(v * factor * (1 + (rnd() - 0.5) * 0.16) -
          (i * v * 0.004)));
      });
    }

    var revenue   = series(420000, 0.045, 0.18);
    var customers = series(64, 0.05, 0.2);
    var leads     = series(310, 0.035, 0.22);

    var sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };

    var newCustomers = Math.round(sum(customers) * 0.62);
    var csCustomers  = sum(customers) - newCustomers;
    var newRevenue   = Math.round(sum(revenue) * 0.58);
    var csRevenue    = sum(revenue) - newRevenue;
    var newProspects = Math.round(sum(leads) * 0.66);
    var csProspects  = sum(leads) - newProspects;
    var totalCust    = newCustomers + csCustomers;

    /* Quarterly: real quarters only — a quarter that has not started is null. */
    var q = [];
    var lastQ = (year === new Date().getFullYear()) ? currentQuarter() : 4;
    for (var i = 0; i < 4; i++) q.push(i < lastQ ? i : null);

    function quarterly(base, growth) {
      return q.map(function (idx) {
        return idx == null ? null
          : Math.round(base * (1 + growth * idx) * (1 + (rnd() - 0.5) * 0.12) * mult);
      });
    }

    var qRevenue   = quarterly(1250000, 0.09);
    var qCustomers = quarterly(196, 0.1);
    var qLeads     = quarterly(940, 0.07);

    var booked  = series(88, 0.04, 0.16);
    var churned = series(19, -0.02, 0.3);

    var psePse  = series(64, 0.012, 0.1).map(function (v) { return Math.min(100, v / mult); });
    var pseRev  = series(48, 0.02, 0.12).map(function (v) { return Math.min(100, v / mult); });
    var pseCust = series(37, 0.015, 0.14).map(function (v) { return Math.min(100, v / mult); });

    var guidedC = series(52, 0.05, 0.15);
    var selfC   = series(31, 0.08, 0.18);
    var guidedR = series(295000, 0.045, 0.15);
    var selfR   = series(118000, 0.075, 0.2);

    var attained = Math.round(sum(revenue));
    var forecast = Math.round(attained / 0.82);

    return {
      year: year,
      scope: scope,

      ytd: {
        newProspects:     newProspects,
        csProspects:      csProspects,
        newCustomers:     newCustomers,
        csCustomers:      csCustomers,
        totalCustomers:   totalCust,
        convPct:          (totalCust / (newProspects + csProspects)) * 100,
        under5kCustomers: Math.round(totalCust * 0.71),
        over5kCustomers:  totalCust - Math.round(totalCust * 0.71),
        newRevenue:       newRevenue,
        csRevenue:        csRevenue,
        totalRevenue:     newRevenue + csRevenue
      },

      prev: {
        newProspects:     Math.round(newProspects * 0.88),
        csProspects:      Math.round(csProspects * 1.06),
        newCustomers:     Math.round(newCustomers * 0.91),
        csCustomers:      Math.round(csCustomers * 0.97),
        totalCustomers:   Math.round(totalCust * 0.93),
        convPct:          (totalCust / (newProspects + csProspects)) * 100 * 0.95,
        under5kCustomers: Math.round(totalCust * 0.71 * 0.9),
        over5kCustomers:  Math.round((totalCust - Math.round(totalCust * 0.71)) * 1.04),
        newRevenue:       Math.round(newRevenue * 0.86),
        csRevenue:        Math.round(csRevenue * 1.02),
        totalRevenue:     Math.round((newRevenue + csRevenue) * 0.92)
      },

      monthly:   { revenue: revenue, customers: customers, leads: leads },
      quarterly: { revenue: qRevenue, customers: qCustomers, leads: qLeads },

      lastYear: {
        monthly: {
          revenue:   ghost(revenue, 0.87),
          customers: ghost(customers, 0.9),
          leads:     ghost(leads, 0.94)
        },
        quarterly: {
          revenue:   qRevenue.map(function (v) { return v == null ? null : Math.round(v * 0.88); }),
          customers: qCustomers.map(function (v) { return v == null ? null : Math.round(v * 0.92); }),
          leads:     qLeads.map(function (v) { return v == null ? null : Math.round(v * 0.95); })
        },
        bookings: { booked: ghost(booked, 0.89), churned: ghost(churned, 1.18) },
        pse: {
          pse:       ghost(psePse, 0.93),
          revenue:   ghost(pseRev, 0.9),
          customers: ghost(pseCust, 0.95)
        },
        channel: {
          guidedCustomers:    ghost(guidedC, 0.93),
          selfServeCustomers: ghost(selfC, 0.74),
          guidedRevenue:      ghost(guidedR, 0.91),
          selfServeRevenue:   ghost(selfR, 0.7)
        }
      },

      targets: {
        monthlyRevenue:   Math.round(520000 * mult),
        monthlyCustomers: Math.round(78 * mult),
        quarterlyRevenue: Math.round(1500000 * mult),
        pseClosureRate:   70
      },

      pipeline: {
        qualifiedLostCustomers: Math.round(41 * mult),
        lostRevenue:            Math.round(386000 * mult),
        pipelineRevenueQuarter: Math.round(1420000 * mult),
        pipelineRevenueYear:    Math.round(5180000 * mult),
        pipelineOverdue:        Math.round(742000 * mult),
        forecastRevenue:        forecast,
        attainedRevenue:        attained
      },
      prevPipeline: {
        qualifiedLostCustomers: Math.round(47 * mult),
        lostRevenue:            Math.round(412000 * mult)
      },

      bookings: { booked: booked, churned: churned },
      pse:      { pse: psePse, revenue: pseRev, customers: pseCust },
      channel:  {
        guidedCustomers: guidedC, selfServeCustomers: selfC,
        guidedRevenue: guidedR,  selfServeRevenue: selfR
      }
    };
  }

  /* ======================================================================
     5. Chart engine
     ====================================================================== */

  var SVG_NS = "http://www.w3.org/2000/svg";

  /* ---- 5.1 Primitives -------------------------------------------------- */

  function el(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) {
        node.setAttribute(k, attrs[k]);
      }
    }
    return node;
  }

  /** Axis ticks rounded to clean numbers. */
  function niceScale(max, tickCount) {
    if (!isFinite(max) || max <= 0) {
      return { max: 1, ticks: [0, 0.5, 1] };
    }
    var raw = max / tickCount;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    step *= mag;

    var niceMax = Math.ceil(max / step) * step;
    var ticks = [];
    for (var v = 0; v <= niceMax + step * 1e-6; v += step) {
      ticks.push(Math.round(v * 1e6) / 1e6);
    }
    return { max: niceMax, ticks: ticks };
  }

  /**
   * Ceiling for a plot. Includes whatever overlays are switched on, so a
   * target line above the data or a taller prior year never gets clipped.
   */
  function plotMax(list) {
    var m = 0;
    var targeted = false;
    list.forEach(function (s) {
      var pools = [s.values];
      if (VIEW.compare && s.compare) pools.push(s.compare);
      if (VIEW.target && s.target) { pools.push(s.target); targeted = true; }
      pools.forEach(function (arr) {
        arr.forEach(function (v) { if (v != null && v > m) m = v; });
      });
    });
    /* A quota is often a round number that lands exactly on the ceiling,
       pinning its marker to the top gridline where it reads as chrome.
       A little headroom keeps the reference line legible as data. */
    return targeted ? m * 1.06 : m;
  }

  /**
   * Build the SVG path for a series, breaking the line at nulls so a missing
   * month reads as a gap instead of a plunge to zero.
   */
  function linePath(values, x, y) {
    var d = "";
    var pen = false;
    for (var i = 0; i < values.length; i++) {
      if (values[i] == null) { pen = false; continue; }
      d += (pen ? "L" : "M") + x(i).toFixed(2) + " " + y(values[i]).toFixed(2) + " ";
      pen = true;
    }
    return d.trim();
  }

  function areaPath(values, x, y, baseY) {
    var segs = [];
    var run = [];
    values.forEach(function (v, i) {
      if (v == null) { if (run.length) segs.push(run); run = []; }
      else run.push(i);
    });
    if (run.length) segs.push(run);

    return segs.filter(function (s) { return s.length > 1; }).map(function (s) {
      var d = "M" + x(s[0]) + " " + baseY;
      s.forEach(function (i) { d += "L" + x(i).toFixed(2) + " " + y(values[i]).toFixed(2); });
      d += "L" + x(s[s.length - 1]) + " " + baseY + "Z";
      return d;
    }).join(" ");
  }

  /**
   * Band between an actual line and its target, drawn only where the actual
   * falls SHORT. Crossings are interpolated so the wash starts exactly where
   * the lines cross, not at the next whole month.
   */
  function shortfallPath(values, target, x, y) {
    var out = "";
    for (var i = 0; i < values.length - 1; i++) {
      var a0 = values[i], a1 = values[i + 1];
      var t0 = target[i], t1 = target[i + 1];
      if (a0 == null || a1 == null || t0 == null || t1 == null) continue;

      var d0 = t0 - a0, d1 = t1 - a1;      // positive = below target
      if (d0 <= 0 && d1 <= 0) continue;

      var xa = x(i), xb = x(i + 1);
      var pts;

      if (d0 > 0 && d1 > 0) {
        pts = [[xa, y(a0)], [xb, y(a1)], [xb, y(t1)], [xa, y(t0)]];
      } else {
        /* one end is above target — split at the crossing */
        var f = d0 / (d0 - d1);
        var xc = xa + (xb - xa) * f;
        var yc = y(a0 + (a1 - a0) * f);
        pts = d0 > 0
          ? [[xa, y(a0)], [xc, yc], [xa, y(t0)]]
          : [[xc, yc], [xb, y(a1)], [xb, y(t1)]];
      }

      out += "M" + pts.map(function (p) {
        return p[0].toFixed(2) + " " + p[1].toFixed(2);
      }).join("L") + "Z ";
    }
    return out.trim();
  }

  /** Least-squares fit over the non-null points; null if there are too few. */
  function linearFit(values) {
    var n = 0, sx = 0, sy = 0, sxy = 0, sxx = 0;
    values.forEach(function (v, i) {
      if (v == null) return;
      n++; sx += i; sy += v; sxy += i * v; sxx += i * i;
    });
    if (n < 3) return null;
    var denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    var m = (n * sxy - sx * sy) / denom;
    return { m: m, b: (sy - m * sx) / n };
  }

  function lastIndex(values) {
    for (var i = values.length - 1; i >= 0; i--) if (values[i] != null) return i;
    return -1;
  }

  /* ---- 5.2 Chart types & dispatcher ------------------------------------

     Each card offers a few forms of the same data. The choice lives in
     CHART_TYPE keyed by the card, so it survives a re-render (filter change,
     zoom, overlay toggle) instead of snapping back to the default.

     Which forms a card may offer is not cosmetic — it follows the units:
       · series sharing a unit   -> line / area / grouped bars / stacked
       · series of MIXED units   -> faceted panels only. There is no option
                                    here that puts them on one axis, because
                                    that would need a second y-scale.
       · stacked & 100% share    -> only where the parts genuinely sum to a
                                    meaningful whole (channel mix), never for
                                    unrelated series like booked vs churned.
  ---------------------------------------------------------------------- */

  var CHART_TYPE = {};

  /* Mixed units — every option stays faceted. */
  var PANEL_TYPES = [
    { id: "panel-bar",  label: "Bars" },
    { id: "panel-hist", label: "Histogram" },
    { id: "panel-line", label: "Lines" },
    { id: "panel-area", label: "Area" }
  ];

  /* Same unit, but the series are independent quantities — comparison forms
     only. No stacking: booked + churned is not a meaningful total. */
  var SERIES_TYPES = [
    { id: "bar",  label: "Bars" },
    { id: "line", label: "Line" },
    { id: "area", label: "Area" }
  ];

  /* Rates that share an axis. Stacking percentages of different denominators
     would invent a total, so it is not offered. */
  var RATE_TYPES = [
    { id: "line", label: "Line" },
    { id: "bar",  label: "Bars" },
    { id: "area", label: "Area" }
  ];

  /* Channel mix: the parts really do sum to the whole, so part-to-whole
     forms are legitimate here and nowhere else on this dashboard. */
  var MIX_TYPES = [
    { id: "stacked",    label: "Stacked" },
    { id: "share",      label: "100%" },
    { id: "bar",        label: "Grouped" },
    { id: "stack-area", label: "Area" }
  ];

  /* stacking is part-to-whole; overlays on top of a stack are meaningless */
  function supportsOverlays(type) {
    return type !== "stacked" && type !== "share" && type !== "stack-area";
  }

  function currentType(spec) {
    return CHART_TYPE[spec.key] || spec.defaultType ||
      (spec.mode === "panels" ? "panel-bar" : "line");
  }

  function draw(host) {
    var spec = host.__spec;
    if (!spec) return;

    var width = host.clientWidth || 520;
    if (width < 80) return;

    host.textContent = "";

    var muted = host.__muted || {};
    var live = spec.series.filter(function (s) {
      return !muted[s.id] && s.values.some(function (v) { return v != null; });
    });

    if (!live.length || !spec.labels.length) {
      var empty = document.createElement("div");
      empty.className = "lp-empty";
      empty.textContent = live.length ? "No data for this period" : "All series hidden";
      host.appendChild(empty);
      return;
    }

    var type = currentType(spec);

    if (type.indexOf("panel-") === 0) {
      drawPanels(host, spec, live, width, type.slice(6));
    } else if (type === "bar" || type === "stacked" || type === "share") {
      drawBars(host, spec, live, width, type);
    } else {
      drawOverlay(host, spec, live, width, type);
    }
  }

  /* ---- 5.2b Bar geometry ----------------------------------------------- */

  /** Column with a 4px rounded cap and a square foot on the baseline. */
  function barPath(x, y, w, h, r) {
    if (h <= 0) h = 0;
    r = Math.min(r, w / 2, h);
    var b = y + h;
    return "M" + x + " " + b +
           "V" + (y + r) +
           "Q" + x + " " + y + " " + (x + r) + " " + y +
           "H" + (x + w - r) +
           "Q" + (x + w) + " " + y + " " + (x + w) + " " + (y + r) +
           "V" + b + "Z";
  }

  /** Slot widths for a band: cap thickness, never fill the band. */
  function barMetrics(plotW, n, seriesCount) {
    var band = plotW / Math.max(1, n);
    var inner = band * 0.68;                 // leave the rest as air
    var gap = seriesCount > 1 ? 2 : 0;       // 2px surface gap between bars
    var w = Math.max(3, Math.min(24, (inner - gap * (seriesCount - 1)) / seriesCount));
    var groupW = w * seriesCount + gap * (seriesCount - 1);
    return { band: band, w: w, gap: gap, groupW: groupW };
  }

  /* ---- 5.3 Overlay: several series, ONE shared y-scale ----------------
     Only ever called with series that share a unit. Mixed units go to
     drawPanels instead — this codebase has no dual-axis path.
  ---------------------------------------------------------------------- */

  function drawOverlay(host, spec, live, width, type) {
    var fmt = formatter(spec.valueFormat);
    var isArea = type === "area";
    var isStackArea = type === "stack-area";

    /* Running totals for the stacked-area form. Two overlapping washes read
       as a muddy third colour, so a part-to-whole area chart stacks into
       bands instead of layering transparencies. */
    var cum = null;
    if (isStackArea) {
      cum = live.map(function () { return []; });
      for (var ci = 0; ci < spec.labels.length; ci++) {
        var run = 0, seen = false;
        live.forEach(function (s, si) {
          if (s.values[ci] != null) { run += s.values[ci]; seen = true; }
          cum[si][ci] = seen ? run : null;
        });
      }
    }
    var pad = { t: 12, r: 64, b: 24, l: 52 };
    var height = 210;
    var plotW = width - pad.l - pad.r;
    var plotH = height - pad.t - pad.b;
    var n = spec.labels.length;

    /* a stack is measured by its total, not by its tallest part */
    var scale = niceScale(
      isStackArea ? plotMax([{ values: cum[cum.length - 1] }]) : plotMax(live), 4);
    var x = function (i) { return pad.l + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1)); };
    var y = function (v) { return pad.t + plotH - (v / scale.max) * plotH; };

    var svg = el("svg", {
      viewBox: "0 0 " + width + " " + height,
      width: width, height: height, tabindex: "0",
      role: "img", "aria-label": spec.ariaLabel || spec.title || "chart"
    });

    /* gridlines + y ticks — hairline, solid, recessive */
    scale.ticks.forEach(function (t) {
      svg.appendChild(el("line", {
        x1: pad.l, x2: pad.l + plotW, y1: y(t), y2: y(t),
        stroke: t === 0 ? cssVar("--baseline") : cssVar("--grid"), "stroke-width": 1
      }));
      var lbl = el("text", {
        x: pad.l - 8, y: y(t) + 3.5, "text-anchor": "end",
        fill: cssVar("--z-ink-3"), "font-size": "10"
      });
      lbl.style.fontVariantNumeric = "tabular-nums";
      lbl.textContent = fmt(t);
      svg.appendChild(lbl);
    });

    /* x labels — thinned so they never collide */
    var every = Math.ceil(n / Math.max(2, Math.floor(plotW / 42)));
    spec.labels.forEach(function (label, i) {
      if (i % every !== 0 && i !== n - 1) return;
      var t = el("text", {
        x: x(i), y: pad.t + plotH + 15, "text-anchor": "middle",
        fill: cssVar("--z-ink-3"), "font-size": "10"
      });
      t.textContent = label;
      svg.appendChild(t);
    });

    /* --- analysis layer, behind the actuals --- */

    if (VIEW.target) {
      live.forEach(function (s) {
        if (!s.target) return;
        svg.appendChild(el("path", {
          d: shortfallPath(s.values, s.target, x, y),
          fill: cssVar("--bad"), "fill-opacity": ".09", stroke: "none"
        }));
        svg.appendChild(el("path", {
          d: linePath(s.target, x, y),
          fill: "none", stroke: cssVar(s.hue), "stroke-width": 1.5,
          "stroke-dasharray": "1 4", "stroke-opacity": ".9", "stroke-linecap": "round"
        }));
      });
    }

    if (VIEW.compare) {
      live.forEach(function (s) {
        if (!s.compare) return;
        svg.appendChild(el("path", {
          d: linePath(s.compare, x, y),
          fill: "none", stroke: cssVar(s.hue), "stroke-width": 1.5,
          "stroke-opacity": ".4", "stroke-dasharray": "6 3",
          "stroke-linecap": "round", "stroke-linejoin": "round"
        }));
      });
    }

    if (VIEW.trend) {
      live.forEach(function (s) {
        var fit = linearFit(s.values);
        if (!fit) return;
        var y0 = Math.max(0, Math.min(scale.max, fit.b));
        var y1 = Math.max(0, Math.min(scale.max, fit.m * (n - 1) + fit.b));
        svg.appendChild(el("line", {
          x1: x(0), y1: y(y0), x2: x(n - 1), y2: y(y1),
          stroke: cssVar(s.hue), "stroke-width": 1.5, "stroke-opacity": ".5",
          "stroke-dasharray": "10 5", "stroke-linecap": "round"
        }));
      });
    }

    if (isStackArea) {
      /* Paint from the top of the stack downwards: each band's own fill
         covers the one above it, leaving exactly its own slice visible. The
         2px surface-coloured top edge is the gap that separates them. */
      for (var k = live.length - 1; k >= 0; k--) {
        svg.appendChild(el("path", {
          d: areaPath(cum[k], x, y, pad.t + plotH),
          fill: cssVar(live[k].hue), "fill-opacity": ".92", stroke: "none"
        }));
        svg.appendChild(el("path", {
          d: linePath(cum[k], x, y),
          fill: "none", stroke: cssVar("--z-surface"), "stroke-width": 2,
          "stroke-linejoin": "round"
        }));
      }
    } else {
      /* A single series always gets an area wash; multiples only when the
         reader has explicitly asked for the area form. */
      if (isArea || live.length === 1) {
        live.forEach(function (s) {
          svg.appendChild(el("path", {
            d: areaPath(s.values, x, y, pad.t + plotH),
            fill: cssVar(s.hue),
            "fill-opacity": live.length > 1 ? ".13" : ".10",
            stroke: "none"
          }));
        });
      }

      live.forEach(function (s) {
        svg.appendChild(el("path", {
          d: linePath(s.values, x, y),
          fill: "none", stroke: cssVar(s.hue), "stroke-width": 2,
          "stroke-linecap": "round", "stroke-linejoin": "round"
        }));
      });
    }

    /* end dots — 2px surface ring so crossings stay legible */
    var ends = [];
    if (!isStackArea) live.forEach(function (s) {
      var i = lastIndex(s.values);
      if (i < 0) return;
      svg.appendChild(el("circle", {
        cx: x(i), cy: y(s.values[i]), r: 4,
        fill: cssVar(s.hue), stroke: cssVar("--z-surface"), "stroke-width": 2
      }));
      ends.push({ s: s, y: y(s.values[i]), v: s.values[i] });
    });

    /* Direct end-labels, but only where they will not collide. When lines
       converge we drop the labels and let the legend + tooltip carry it —
       nudging them apart would detach them from their lines. */
    ends.sort(function (a, b) { return a.y - b.y; });
    var roomy = ends.every(function (e, i) {
      return i === 0 || (e.y - ends[i - 1].y) >= 13;
    });
    if (roomy) {
      ends.forEach(function (e) {
        var t = el("text", {
          x: pad.l + plotW + 9, y: e.y + 3.5,
          fill: cssVar("--z-ink-2"), "font-size": "10.5", "font-weight": "600"
        });
        t.textContent = fmt(e.v);
        svg.appendChild(t);
      });
    }

    attachInteractions(svg, spec, live, {
      x: x, n: n, pad: pad, plotW: plotW, plotH: plotH, fmt: fmt,
      /* stacked bands sit at cumulative heights, so a dot at the raw value
         would float off its own band — the crosshair carries it instead */
      yShared: isStackArea ? null : y
    });

    host.appendChild(svg);
  }

  /* ---- 5.3b Bars: grouped columns, stacks, and 100% share -------------
     One shared y-scale, same as the line form — only ever called with
     series that share a unit.
  ---------------------------------------------------------------------- */

  function drawBars(host, spec, live, width, mode) {
    var stacked = mode === "stacked" || mode === "share";
    var share = mode === "share";
    var fmt = share ? fmtPercent : formatter(spec.valueFormat);
    var withOverlays = supportsOverlays(mode);

    var pad = { t: 12, r: stacked ? 20 : 56, b: 24, l: 52 };
    var height = 210;
    var plotW = width - pad.l - pad.r;
    var plotH = height - pad.t - pad.b;
    var n = spec.labels.length;

    /* stacks scale on the column total; groups on the tallest single bar */
    var ceiling;
    if (share) {
      ceiling = 100;
    } else if (stacked) {
      ceiling = 0;
      for (var i = 0; i < n; i++) {
        var t = 0;
        live.forEach(function (s) { if (s.values[i] != null) t += s.values[i]; });
        if (t > ceiling) ceiling = t;
      }
    } else {
      ceiling = plotMax(withOverlays ? live : live.map(function (s) {
        return { values: s.values };
      }));
    }

    var scale = share
      ? { max: 100, ticks: [0, 25, 50, 75, 100] }
      : niceScale(ceiling, 4);

    var x = function (i) { return pad.l + (plotW * (i + 0.5)) / Math.max(1, n); };
    var y = function (v) { return pad.t + plotH - (v / scale.max) * plotH; };

    var svg = el("svg", {
      viewBox: "0 0 " + width + " " + height,
      width: width, height: height, tabindex: "0",
      role: "img", "aria-label": spec.ariaLabel || spec.title || "chart"
    });

    scale.ticks.forEach(function (t) {
      svg.appendChild(el("line", {
        x1: pad.l, x2: pad.l + plotW, y1: y(t), y2: y(t),
        stroke: t === 0 ? cssVar("--baseline") : cssVar("--grid"), "stroke-width": 1
      }));
      var lbl = el("text", {
        x: pad.l - 8, y: y(t) + 3.5, "text-anchor": "end",
        fill: cssVar("--z-ink-3"), "font-size": "10"
      });
      lbl.style.fontVariantNumeric = "tabular-nums";
      lbl.textContent = fmt(t);
      svg.appendChild(lbl);
    });

    var every = Math.ceil(n / Math.max(2, Math.floor(plotW / 42)));
    spec.labels.forEach(function (label, i) {
      if (i % every !== 0 && i !== n - 1) return;
      var t = el("text", {
        x: x(i), y: pad.t + plotH + 15, "text-anchor": "middle",
        fill: cssVar("--z-ink-3"), "font-size": "10"
      });
      t.textContent = label;
      svg.appendChild(t);
    });

    var m = barMetrics(plotW, n, stacked ? 1 : live.length);
    var baseY = pad.t + plotH;

    if (stacked) {
      for (var bi = 0; bi < n; bi++) {
        /* normalise the column for the 100% form */
        var total = 0;
        live.forEach(function (s) { if (s.values[bi] != null) total += s.values[bi]; });
        if (share && total <= 0) continue;

        var cursor = 0;
        var parts = [];
        live.forEach(function (s) {
          var raw = s.values[bi];
          if (raw == null) return;
          var v = share ? (raw / total) * 100 : raw;
          parts.push({ s: s, v: v, from: cursor });
          cursor += v;
        });

        parts.forEach(function (p, pi) {
          var yTop = y(p.from + p.v);
          var yBot = y(p.from);
          var h = yBot - yTop;
          /* 2px surface gap between touching segments does the separating */
          if (pi < parts.length - 1) h = Math.max(0, h - 2);
          var isTop = pi === parts.length - 1;
          svg.appendChild(el("path", {
            d: barPath(x(bi) - m.w / 2, yBot - h, m.w, h, isTop ? 4 : 0),
            fill: cssVar(p.s.hue)
          }));
        });
      }
    } else {
      live.forEach(function (s, si) {
        var offset = -m.groupW / 2 + si * (m.w + m.gap);

        /* prior year sits behind as a translucent ghost column */
        if (withOverlays && VIEW.compare && s.compare) {
          s.compare.forEach(function (v, i) {
            if (v == null) return;
            svg.appendChild(el("path", {
              d: barPath(x(i) + offset - 2, y(v), m.w + 4, baseY - y(v), 4),
              fill: cssVar(s.hue), "fill-opacity": ".18"
            }));
          });
        }

        s.values.forEach(function (v, i) {
          if (v == null) return;
          svg.appendChild(el("path", {
            d: barPath(x(i) + offset, y(v), m.w, baseY - y(v), 4),
            fill: cssVar(s.hue)
          }));
        });

        /* target as a bullet-chart tick laid across each column */
        if (withOverlays && VIEW.target && s.target) {
          s.target.forEach(function (t, i) {
            if (t == null) return;
            svg.appendChild(el("line", {
              x1: x(i) + offset - 2, x2: x(i) + offset + m.w + 2,
              y1: y(t), y2: y(t),
              stroke: cssVar("--z-ink"), "stroke-width": 2,
              "stroke-opacity": ".75", "stroke-linecap": "round"
            }));
          });
        }

        if (withOverlays && VIEW.trend) {
          var fit = linearFit(s.values);
          if (fit) {
            var v0 = Math.max(0, Math.min(scale.max, fit.b));
            var v1 = Math.max(0, Math.min(scale.max, fit.m * (n - 1) + fit.b));
            svg.appendChild(el("line", {
              x1: x(0), y1: y(v0), x2: x(n - 1), y2: y(v1),
              stroke: cssVar(s.hue), "stroke-width": 1.5, "stroke-opacity": ".5",
              "stroke-dasharray": "10 5", "stroke-linecap": "round"
            }));
          }
        }
      });

      /* label the final column of each series — sparing, and only when the
         column is wide enough that the text is not wider than its mark */
      if (m.w >= 16) {
        live.forEach(function (s, si) {
          var li = lastIndex(s.values);
          if (li < 0) return;
          var offset = -m.groupW / 2 + si * (m.w + m.gap);
          var t = el("text", {
            x: x(li) + offset + m.w / 2, y: y(s.values[li]) - 6,
            "text-anchor": "middle",
            fill: cssVar("--z-ink-2"), "font-size": "10", "font-weight": "600"
          });
          t.textContent = fmt(s.values[li]);
          svg.appendChild(t);
        });
      }
    }

    attachInteractions(svg, spec, live, {
      x: x, n: n, pad: pad, plotW: plotW, plotH: plotH, fmt: fmt,
      bandW: m.band, share: share
    });

    host.appendChild(svg);
  }

  /* ---- 5.4 Panels: small multiples, one scale EACH --------------------
     The honest answer to "Revenue, Customers and Leads on one chart": three
     stacked panels sharing an x-axis, each with its own y-scale. One
     crosshair spans them all, so the reader still compares at a glance.
     `variant` picks the mark — line, bar or area — without ever merging the
     panels onto a shared scale.
  ---------------------------------------------------------------------- */

  function drawPanels(host, spec, live, width, variant) {
    /* "hist" is the same column mark filling its whole band, so neighbours
       read as one continuous block — the histogram look. It keeps the 2px
       surface gap that separates every touching mark in this system. */
    var isHist = variant === "hist";
    var isBar = variant === "bar" || isHist;
    var isArea = variant === "area";

    var headH = 15, plotH = 52, gapH = 14, axisH = 20;
    var pad = { t: 6, r: 14, l: 52 };
    var plotW = width - pad.l - pad.r;
    var n = spec.labels.length;
    var height = pad.t + live.length * (headH + plotH) + (live.length - 1) * gapH + axisH;

    /* bars sit in the middle of a band; points sit on the tick */
    var x = isBar
      ? function (i) { return pad.l + (plotW * (i + 0.5)) / Math.max(1, n); }
      : function (i) { return pad.l + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1)); };

    var band = plotW / Math.max(1, n);
    var barW = isHist
      ? Math.max(2, band - 2)                      // full band, less the gap
      : Math.max(3, Math.min(18, band * 0.6));
    /* a full-width column has no room to spare, so its ghost and tick stay
       inside the band instead of spilling over the neighbours */
    var overhang = isHist ? 0 : 2;

    var svg = el("svg", {
      viewBox: "0 0 " + width + " " + height,
      width: width, height: height, tabindex: "0",
      role: "img", "aria-label": spec.ariaLabel || spec.title || "chart"
    });

    var panels = [];

    live.forEach(function (s, pi) {
      var top = pad.t + pi * (headH + plotH + gapH);
      var plotTop = top + headH;
      var fmt = formatter(s.format || spec.valueFormat);
      /* 3 candidate ticks lands on a tighter ceiling than 2, so a short panel
         spends its height on the mark instead of on empty headroom. */
      var scale = niceScale(plotMax([s]), 3);
      var y = function (v) { return plotTop + plotH - (v / scale.max) * plotH; };
      var baseY = y(0);

      panels.push({ s: s, y: y, fmt: fmt, top: plotTop });

      /* panel header: key + name on the left, latest value on the right */
      if (isBar) {
        svg.appendChild(el("rect", {
          x: pad.l, y: top + 3, width: 9, height: 9, rx: 2.5, fill: cssVar(s.hue)
        }));
      } else {
        svg.appendChild(el("rect", {
          x: pad.l, y: top + 6, width: 10, height: 3, rx: 1.5, fill: cssVar(s.hue)
        }));
      }

      var name = el("text", {
        x: pad.l + 16, y: top + 10.5,
        fill: cssVar("--z-ink-2"), "font-size": "10.5", "font-weight": "500"
      });
      name.textContent = s.name;
      svg.appendChild(name);

      var li = lastIndex(s.values);
      if (li >= 0) {
        var headBits = [fmt(s.values[li])];

        /* headline context: YoY when comparing, attainment when targeting */
        if (VIEW.compare && s.compare && s.compare[li] != null && s.compare[li] !== 0) {
          var yoy = fmtSignedPct(((s.values[li] - s.compare[li]) / Math.abs(s.compare[li])) * 100);
          if (yoy) headBits.push(yoy + " YoY");
        } else if (VIEW.target && s.target && s.target[li]) {
          headBits.push(Math.round((s.values[li] / s.target[li]) * 100) + "% of target");
        }

        var val = el("text", {
          x: pad.l + plotW, y: top + 10.5, "text-anchor": "end",
          fill: cssVar("--z-ink"), "font-size": "11", "font-weight": "600"
        });
        val.textContent = headBits[0];
        svg.appendChild(val);

        if (headBits[1]) {
          /* The SVG is still detached here, so getComputedTextLength() would
             return 0 and stack the two labels. Reserve a fixed 58px gutter
             instead — values are compacted ($1.2M / 12.9K), so they never
             run past it. */
          var ctx = el("text", {
            x: pad.l + plotW - 58, y: top + 10.5, "text-anchor": "end",
            fill: cssVar("--z-ink-3"), "font-size": "10"
          });
          ctx.textContent = headBits[1];
          svg.appendChild(ctx);
        }
      }

      /* baseline + a single top gridline keeps each panel readable but quiet */
      [0, scale.max].forEach(function (t) {
        svg.appendChild(el("line", {
          x1: pad.l, x2: pad.l + plotW, y1: y(t), y2: y(t),
          stroke: t === 0 ? cssVar("--baseline") : cssVar("--grid"), "stroke-width": 1
        }));
      });

      var tick = el("text", {
        x: pad.l - 8, y: y(scale.max) + 3.5, "text-anchor": "end",
        fill: cssVar("--z-ink-3"), "font-size": "9.5"
      });
      tick.textContent = fmt(scale.max);
      svg.appendChild(tick);

      /* --- analysis layer, behind the marks --- */
      if (VIEW.target && s.target && !isBar) {
        svg.appendChild(el("path", {
          d: shortfallPath(s.values, s.target, x, y),
          fill: cssVar("--bad"), "fill-opacity": ".09", stroke: "none"
        }));
        svg.appendChild(el("path", {
          d: linePath(s.target, x, y),
          fill: "none", stroke: cssVar(s.hue), "stroke-width": 1.5,
          "stroke-dasharray": "1 4", "stroke-opacity": ".9", "stroke-linecap": "round"
        }));
      }

      if (VIEW.compare && s.compare && !isBar) {
        svg.appendChild(el("path", {
          d: linePath(s.compare, x, y),
          fill: "none", stroke: cssVar(s.hue), "stroke-width": 1.5,
          "stroke-opacity": ".4", "stroke-dasharray": "6 3", "stroke-linecap": "round"
        }));
      }

      /* --- the marks --- */
      if (isBar) {
        if (VIEW.compare && s.compare) {
          s.compare.forEach(function (v, i) {
            if (v == null) return;
            /* painted first, so only the part standing above this year's
               column stays visible — that overhang IS the comparison */
            svg.appendChild(el("path", {
              d: barPath(x(i) - barW / 2 - overhang, y(v),
                         barW + overhang * 2, baseY - y(v), 3),
              fill: cssVar(s.hue), "fill-opacity": ".18"
            }));
          });
        }
        s.values.forEach(function (v, i) {
          if (v == null) return;
          svg.appendChild(el("path", {
            d: barPath(x(i) - barW / 2, y(v), barW, baseY - y(v), 3),
            fill: cssVar(s.hue)
          }));
        });
        if (VIEW.target && s.target) {
          s.target.forEach(function (t, i) {
            if (t == null) return;
            svg.appendChild(el("line", {
              x1: x(i) - barW / 2 - overhang, x2: x(i) + barW / 2 + overhang,
              y1: y(t), y2: y(t),
              stroke: cssVar("--z-ink"), "stroke-width": 1.75,
              "stroke-opacity": ".75", "stroke-linecap": "round"
            }));
          });
        }
      } else {
        if (isArea) {
          svg.appendChild(el("path", {
            d: areaPath(s.values, x, y, baseY),
            fill: cssVar(s.hue), "fill-opacity": ".14", stroke: "none"
          }));
        }
        svg.appendChild(el("path", {
          d: linePath(s.values, x, y),
          fill: "none", stroke: cssVar(s.hue), "stroke-width": 2,
          "stroke-linecap": "round", "stroke-linejoin": "round"
        }));
        if (li >= 0) {
          svg.appendChild(el("circle", {
            cx: x(li), cy: y(s.values[li]), r: 3.5,
            fill: cssVar(s.hue), stroke: cssVar("--z-surface"), "stroke-width": 2
          }));
        }
      }

      if (VIEW.trend) {
        var fit = linearFit(s.values);
        if (fit) {
          var v0 = Math.max(0, Math.min(scale.max, fit.b));
          var v1 = Math.max(0, Math.min(scale.max, fit.m * (n - 1) + fit.b));
          svg.appendChild(el("line", {
            x1: x(0), y1: y(v0), x2: x(n - 1), y2: y(v1),
            stroke: cssVar(s.hue), "stroke-width": 1.5, "stroke-opacity": ".5",
            "stroke-dasharray": "10 5", "stroke-linecap": "round"
          }));
        }
      }
    });

    var axisY = height - 6;
    var every = Math.ceil(n / Math.max(2, Math.floor(plotW / 42)));
    spec.labels.forEach(function (label, i) {
      if (i % every !== 0 && i !== n - 1) return;
      var t = el("text", {
        x: x(i), y: axisY, "text-anchor": "middle",
        fill: cssVar("--z-ink-3"), "font-size": "10"
      });
      t.textContent = label;
      svg.appendChild(t);
    });

    attachInteractions(svg, spec, live, {
      x: x, n: n, pad: { t: pad.t, l: pad.l },
      plotW: plotW, plotH: height - pad.t - axisH,
      panels: panels, bandW: isBar ? band : 0
    });

    host.appendChild(svg);
  }

  /* ---- 5.5 Interaction: hover · brush-zoom · drill --------------------
     The crosshair finds the X — the reader aims at a month, never at a 2px
     line — and one tooltip lists every series at that X. Dragging selects a
     month range (linked across every month chart); a click without a drag
     opens the records behind that point.
  ---------------------------------------------------------------------- */

  function attachInteractions(svg, spec, live, geo) {
    /* Bars own their category, so the hover target is the whole band and it
       lights up; lines get the crosshair + per-series dots instead. */
    var banded = !!geo.bandW;

    var bandHi = banded ? el("rect", {
      y: geo.pad.t, height: geo.plotH, width: geo.bandW, x: 0, rx: 6,
      fill: cssVar("--z-ink"), "fill-opacity": ".05", opacity: "0"
    }) : null;
    if (bandHi) svg.appendChild(bandHi);

    var crosshair = el("line", {
      y1: geo.pad.t, y2: geo.pad.t + geo.plotH,
      stroke: cssVar("--z-ink-3"), "stroke-width": 1, opacity: "0"
    });
    if (!banded) svg.appendChild(crosshair);

    var dots = live.map(function (s) {
      var c = el("circle", {
        r: 4, fill: cssVar(s.hue),
        stroke: cssVar("--z-surface"), "stroke-width": 2, opacity: "0"
      });
      if (!banded) svg.appendChild(c);
      return c;
    });

    var band = el("rect", {
      y: geo.pad.t, height: geo.plotH, width: 0, x: 0,
      fill: cssVar("--z-accent"), "fill-opacity": ".10", opacity: "0"
    });
    svg.appendChild(band);

    /* transparent hit layer — the target is the whole plot, not the marks */
    var hit = el("rect", {
      x: geo.pad.l, y: geo.pad.t, width: geo.plotW, height: geo.plotH,
      fill: "transparent"
    });
    if (spec.zoomable) hit.setAttribute("cursor", "crosshair");
    svg.appendChild(hit);

    var active = -1;
    var drag = null;

    function localX(evt) {
      var box = svg.getBoundingClientRect();
      var k = box.width / svg.viewBox.baseVal.width || 1;
      return (evt.clientX - box.left) / k;
    }

    /** Category index under a plot-local x, for point and band layouts. */
    function indexAtX(lx) {
      var t = banded
        ? Math.floor((lx - geo.pad.l) / geo.bandW)
        : (geo.n === 1 ? 0
            : Math.round((lx - geo.pad.l) / (geo.plotW / (geo.n - 1))));
      return Math.max(0, Math.min(geo.n - 1, t));
    }

    function nearest(evt) { return indexAtX(localX(evt)); }

    function show(i, clientX, clientY) {
      if (i < 0 || i >= geo.n) return;
      active = i;

      var px = geo.x(i);
      if (banded) {
        bandHi.setAttribute("x", px - geo.bandW / 2);
        bandHi.setAttribute("opacity", "1");
      } else {
        crosshair.setAttribute("x1", px);
        crosshair.setAttribute("x2", px);
        crosshair.setAttribute("opacity", ".45");
      }

      var rows = [];
      live.forEach(function (s, si) {
        var v = s.values[i];
        var yFn = geo.panels ? geo.panels[si].y : geo.yShared;
        var f = geo.panels ? geo.panels[si].fmt : geo.fmt;

        if (!banded) {
          if (v == null || !yFn) dots[si].setAttribute("opacity", "0");
          else {
            dots[si].setAttribute("cx", px);
            dots[si].setAttribute("cy", yFn(v));
            dots[si].setAttribute("opacity", "1");
          }
        }

        /* period-over-period movement, the number the reader actually wants */
        var prev = i > 0 ? s.values[i - 1] : null;
        var mom = (v != null && prev != null && prev !== 0)
          ? ((v - prev) / Math.abs(prev)) * 100 : null;
        var up = mom != null && mom >= 0;
        var good = s.upIsGood === false ? !up : up;

        var extras = [];
        if (VIEW.compare && s.compare && s.compare[i] != null) {
          extras.push({ label: "vs " + (spec.compareLabel || "last year"), value: f(s.compare[i]) });
        }
        if (VIEW.target && s.target && s.target[i] != null) {
          var gap = v != null ? v - s.target[i] : null;
          extras.push({
            label: "vs target " + f(s.target[i]),
            value: gap == null ? "–" : (gap >= 0 ? "+" : "") + f(gap)
          });
        }

        rows.push({
          name: s.name,
          color: cssVar(s.hue),
          value: f(v),
          delta: mom == null || Math.abs(mom) < 0.05 ? null : {
            text: fmtSignedPct(mom),
            dir: good ? "good" : "bad"
          },
          extras: extras
        });
      });

      showTip(spec.labels[i], rows, clientX, clientY);
    }

    function hide() {
      active = -1;
      if (bandHi) bandHi.setAttribute("opacity", "0");
      crosshair.setAttribute("opacity", "0");
      dots.forEach(function (d) { d.setAttribute("opacity", "0"); });
      hideTip();
    }

    svg.addEventListener("pointermove", function (e) {
      if (drag) {
        drag.moved = true;
        var cx = Math.max(geo.pad.l, Math.min(geo.pad.l + geo.plotW, localX(e)));
        drag.currentX = cx;
        var x0 = Math.min(drag.startX, cx), x1 = Math.max(drag.startX, cx);
        band.setAttribute("x", x0);
        band.setAttribute("width", x1 - x0);
        band.setAttribute("opacity", "1");
        hideTip();
        crosshair.setAttribute("opacity", "0");
        if (bandHi) bandHi.setAttribute("opacity", "0");
        return;
      }
      show(nearest(e), e.clientX, e.clientY);
    });

    svg.addEventListener("pointerleave", function () { if (!drag) hide(); });
    svg.addEventListener("blur", hide);

    svg.addEventListener("focus", function () {
      var i = active >= 0 ? active : geo.n - 1;
      var box = svg.getBoundingClientRect();
      show(i, box.left + box.width / 2, box.top);
    });

    svg.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && active >= 0) {
        e.preventDefault();
        openDrill(spec, live, active);
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      var i = active < 0 ? geo.n - 1 : active + (e.key === "ArrowRight" ? 1 : -1);
      i = Math.max(0, Math.min(geo.n - 1, i));
      var box = svg.getBoundingClientRect();
      show(i, box.left + geo.x(i) * (box.width / svg.viewBox.baseVal.width), box.top);
    });

    /* --- brush to zoom / click to drill --- */

    svg.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      var lx = localX(e);
      if (lx < geo.pad.l - 4 || lx > geo.pad.l + geo.plotW + 4) return;
      drag = { startX: Math.max(geo.pad.l, Math.min(geo.pad.l + geo.plotW, lx)), moved: false };
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    });

    function endDrag(e) {
      if (!drag) return;
      var d = drag;
      drag = null;
      band.setAttribute("opacity", "0");
      band.setAttribute("width", 0);
      try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }

      var travelled = d.currentX != null ? Math.abs(d.currentX - d.startX) : 0;

      /* a drag selects a range; a tap opens the records behind the point */
      if (spec.zoomable && d.moved && travelled >= 10) {
        var i0 = indexAtX(Math.min(d.startX, d.currentX));
        var i1 = indexAtX(Math.max(d.startX, d.currentX));
        if (i1 - i0 >= 1) {
          var base = spec.rangeBase || 0;
          VIEW.range = [base + i0, base + i1];
          rerender();
        }
        return;
      }

      if (!d.moved || travelled < 6) {
        var i = nearest(e);
        openDrill(spec, live, i);
      }
    }

    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", function (e) {
      drag = null;
      band.setAttribute("opacity", "0");
      try { svg.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
    });
  }

  /* ---- 5.6 Tooltip ----------------------------------------------------- */

  var tipEl = null;

  function showTip(heading, rows, clientX, clientY) {
    if (!tipEl) tipEl = document.getElementById("lp-tip");
    if (!tipEl) return;

    tipEl.textContent = "";

    var head = document.createElement("div");
    head.className = "lp-tip__head";
    head.textContent = heading;            // untrusted label -> textContent
    tipEl.appendChild(head);

    rows.forEach(function (r) {
      var row = document.createElement("div");
      row.className = "lp-tip__row";

      var key = document.createElement("span");
      key.className = "lp-tip__key";
      key.style.background = r.color;

      var name = document.createElement("span");
      name.className = "lp-tip__name";
      name.textContent = r.name;

      var val = document.createElement("span");
      val.className = "lp-tip__value";
      val.textContent = r.value;

      row.appendChild(key);
      row.appendChild(name);
      row.appendChild(val);

      if (r.delta) {
        var d = document.createElement("span");
        d.className = "lp-tip__delta";
        d.setAttribute("data-dir", r.delta.dir);
        d.textContent = r.delta.text;
        row.appendChild(d);
      }
      tipEl.appendChild(row);

      (r.extras || []).forEach(function (x) {
        var sub = document.createElement("div");
        sub.className = "lp-tip__sub";
        var sl = document.createElement("span");
        sl.textContent = x.label;
        var sv = document.createElement("span");
        sv.className = "lp-tip__sub-value";
        sv.textContent = x.value;
        sub.appendChild(sl);
        sub.appendChild(sv);
        tipEl.appendChild(sub);
      });
    });

    var foot = document.createElement("div");
    foot.className = "lp-tip__foot";
    foot.textContent = "Click to see records · drag to zoom";
    tipEl.appendChild(foot);

    tipEl.hidden = false;

    var box = tipEl.getBoundingClientRect();
    var left = clientX + 14;
    var top = clientY - box.height / 2;
    if (left + box.width > window.innerWidth - 8) left = clientX - box.width - 14;
    top = Math.max(8, Math.min(window.innerHeight - box.height - 8, top));
    tipEl.style.left = Math.max(8, left) + "px";
    tipEl.style.top = top + "px";
  }

  function hideTip() {
    if (!tipEl) tipEl = document.getElementById("lp-tip");
    if (tipEl) tipEl.hidden = true;
  }

  /* ---- 5.7 Mount + responsive redraw ---------------------------------- */

  var mounted = [];

  /**
   * Register a chart. Drawing is deferred to drawAll() — a chart measures its
   * own container, and at mount time the card is not in the document yet
   * (clientWidth 0), so an immediate draw would render nothing.
   */
  function mount(hostEl, spec) {
    hostEl.__spec = spec;
    if (mounted.indexOf(hostEl) === -1) mounted.push(hostEl);
  }

  function drawAll() {
    mounted.forEach(function (h) {
      if (h.isConnected && !h.hidden) draw(h);
    });
  }

  var redrawTimer = null;
  function redrawAll() {
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(function () {
      drawAll();
      resizeWidget();
    }, 90);
  }

  window.addEventListener("resize", redrawAll);

  /* ======================================================================
     6. Renderers
     ====================================================================== */

  /* ---- 6.1 Stat tile --------------------------------------------------- */

  function statTile(cfg, data, prev) {
    var tile = document.createElement("div");
    tile.className = "lp-tile";

    var label = document.createElement("div");
    label.className = "lp-tile__label";
    label.textContent = cfg.label;
    tile.appendChild(label);

    var fmt = formatter(cfg.format);

    var value = document.createElement("div");
    value.className = "lp-tile__value";
    value.textContent = fmt(data);
    tile.appendChild(value);

    if (prev != null && isFinite(prev) && prev !== 0 && data != null) {
      var pct = ((data - prev) / Math.abs(prev)) * 100;
      var up = pct >= 0;
      var good = cfg.upIsGood === false ? !up : up;

      var delta = document.createElement("div");
      delta.className = "lp-tile__delta";
      /* the arrow carries direction, so meaning never rests on colour alone */
      delta.setAttribute("data-dir", Math.abs(pct) < 0.05 ? "flat" : (good ? "good" : "bad"));

      var arrow = document.createElement("span");
      arrow.textContent = up ? "▲" : "▼";
      arrow.setAttribute("aria-hidden", "true");

      var text = document.createElement("span");
      text.textContent = Math.abs(Math.round(pct * 10) / 10) + "%";

      var since = document.createElement("span");
      since.className = "lp-tile__delta-since";
      since.textContent = "vs last year";

      delta.appendChild(arrow);
      delta.appendChild(text);
      delta.appendChild(since);
      tile.appendChild(delta);
    } else if (cfg.note) {
      var note = document.createElement("div");
      note.className = "lp-tile__delta";
      note.textContent = cfg.note;
      tile.appendChild(note);
    }

    if (cfg.pair) {
      var sub = document.createElement("div");
      sub.className = "lp-tile__sub";

      var sl = document.createElement("span");
      sl.className = "lp-tile__sub-label";
      sl.textContent = cfg.pair.label;

      var sv = document.createElement("span");
      sv.className = "lp-tile__sub-value";
      sv.textContent = formatter(cfg.pair.format)(cfg.pair.value);

      sub.appendChild(sl);
      sub.appendChild(sv);
      tile.appendChild(sub);
    }

    return tile;
  }

  /* ---- 6.2 Meter — Forecasted vs Attainment ---------------------------- */

  function meterTile(label, forecast, attained) {
    var tile = document.createElement("div");
    tile.className = "lp-tile";

    var lbl = document.createElement("div");
    lbl.className = "lp-tile__label";
    lbl.textContent = label;
    tile.appendChild(lbl);

    var pct = forecast > 0 ? (attained / forecast) * 100 : 0;

    var val = document.createElement("div");
    val.className = "lp-tile__value";
    val.textContent = fmtPercent(pct);
    tile.appendChild(val);

    var meter = document.createElement("div");
    meter.className = "lp-meter";

    var track = document.createElement("div");
    track.className = "lp-meter__track";
    track.setAttribute("role", "meter");
    track.setAttribute("aria-valuenow", Math.round(pct));
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-label", label);

    var fill = document.createElement("div");
    fill.className = "lp-meter__fill";
    fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    fill.setAttribute("data-state", pct >= 90 ? "ok" : pct >= 70 ? "warning" : "danger");

    track.appendChild(fill);
    meter.appendChild(track);

    /* Two labelled rows rather than one line: at six-across the tile is too
       narrow for "Attained $316.7K  Forecast $386.2K" to sit side by side,
       and this keeps the height stable whatever the values read. */
    var legend = document.createElement("div");
    legend.className = "lp-meter__legend";

    [["Attained", attained], ["Forecast", forecast]].forEach(function (pair) {
      var row = document.createElement("div");
      row.className = "lp-meter__row";

      var k = document.createElement("span");
      k.textContent = pair[0];

      var v = document.createElement("span");
      v.className = "lp-meter__row-value";
      v.textContent = fmtCurrency(pair[1]);

      row.appendChild(k);
      row.appendChild(v);
      legend.appendChild(row);
    });

    meter.appendChild(legend);
    tile.appendChild(meter);

    return tile;
  }

  /* ---- 6.3 Chart card -------------------------------------------------- */

  function chartCard(spec) {
    var card = document.createElement("div");
    card.className = "lp-card";

    var head = document.createElement("div");
    head.className = "lp-card__head";

    var titles = document.createElement("div");
    var h3 = document.createElement("h3");
    h3.className = "lp-card__title";
    h3.textContent = spec.title;
    titles.appendChild(h3);

    if (spec.subtitle) {
      var sub = document.createElement("p");
      sub.className = "lp-card__sub";
      sub.textContent = spec.subtitle;
      titles.appendChild(sub);
    }
    head.appendChild(titles);

    var tools = document.createElement("div");
    tools.className = "lp-card__tools";

    /* chart-form switcher — the options a card offers are constrained by its
       units (see § 5.2), so nothing here can produce a two-axis chart */
    var chart = document.createElement("div");
    chart.className = "lp-chart";
    chart.__muted = {};

    if (spec.types && spec.types.length > 1) {
      var seg = document.createElement("div");
      seg.className = "lp-seg";
      seg.setAttribute("role", "group");
      seg.setAttribute("aria-label", "Chart type");

      spec.types.forEach(function (t) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "lp-seg__btn";
        b.textContent = t.label;
        b.setAttribute("aria-pressed", String(currentType(spec) === t.id));

        b.addEventListener("click", function () {
          if (currentType(spec) === t.id) return;
          CHART_TYPE[spec.key] = t.id;
          seg.querySelectorAll(".lp-seg__btn").forEach(function (o) {
            o.setAttribute("aria-pressed", String(o === b));
          });
          /* the legend's overlay keys depend on the form, so rebuild the card */
          rerender();
        });

        seg.appendChild(b);
      });
      tools.appendChild(seg);
    }

    /* every chart keeps a table view — the tooltip enhances, never gates */
    var toggle = document.createElement("button");
    toggle.className = "lp-card__toggle";
    toggle.type = "button";
    toggle.setAttribute("aria-pressed", "false");
    toggle.textContent = "Table";
    tools.appendChild(toggle);

    head.appendChild(tools);
    card.appendChild(head);

    var type = currentType(spec);
    var barLike = type === "bar" || type === "stacked" || type === "share" ||
                  type === "panel-bar" || type === "panel-hist" ||
                  type === "stack-area";

    /* Which analysis overlays are actually on screen for this chart. Their
       encodings need decoding, so they get legend keys of their own —
       otherwise a ghost mark is just an unexplained stroke. Stacked forms
       carry no overlays at all, so they advertise none. */
    function anySeriesHas(prop) {
      return spec.series.some(function (s) { return !!s[prop]; });
    }
    var overlayKeys = [];
    if (supportsOverlays(type)) {
      if (VIEW.compare && anySeriesHas("compare")) {
        overlayKeys.push({
          label: spec.compareLabel || "Last year",
          dash: "6 3", opacity: ".45", ghost: barLike
        });
      }
      if (VIEW.target && anySeriesHas("target")) {
        overlayKeys.push({ label: "Target", dash: "1 4", opacity: ".9", tick: barLike });
      }
      if (VIEW.trend) {
        overlayKeys.push({ label: "Trend", dash: "10 5", opacity: ".6" });
      }
    }

    var wantsSeriesLegend = spec.mode !== "panels" && spec.series.length >= 2;

    /* legend: present for 2+ series in overlay mode; panels self-label.
       Each key is a button that mutes its series — identity stays bound to
       the entity, so muting never repaints the survivors. */
    if (wantsSeriesLegend || overlayKeys.length) {
      var legend = document.createElement("div");
      legend.className = "lp-legend";

      if (wantsSeriesLegend) spec.series.forEach(function (s) {
        var item = document.createElement("button");
        item.type = "button";
        item.className = "lp-legend__item";
        item.setAttribute("aria-pressed", "true");
        item.title = "Show only this series, or hide it";

        /* the legend mirrors the mark: a swatch for bars, a stroke for lines */
        var key = document.createElement("span");
        key.className = barLike ? "lp-legend__swatch" : "lp-legend__key";
        key.style.background = cssVar(s.hue);

        var name = document.createElement("span");
        name.textContent = s.name;

        item.appendChild(key);
        item.appendChild(name);

        item.addEventListener("click", function () {
          var on = !chart.__muted[s.id];
          /* never mute the last visible series — that empties the chart */
          var visible = spec.series.filter(function (o) { return !chart.__muted[o.id]; });
          if (on && visible.length <= 1) return;

          chart.__muted[s.id] = on;
          item.setAttribute("aria-pressed", String(!on));
          draw(chart);
          resizeWidget();
        });

        legend.appendChild(item);
      });

      overlayKeys.forEach(function (o) {
        var item = document.createElement("span");
        item.className = "lp-legend__item lp-legend__item--overlay";

        /* the key mirrors however this overlay is actually drawn in the
           current form: a ghost column, a bullet tick, or a dashed stroke */
        var swatch;
        if (o.ghost) {
          swatch = document.createElement("span");
          swatch.className = "lp-legend__swatch";
          swatch.style.background = cssVar("--z-ink-3");
          swatch.style.opacity = ".28";
        } else {
          swatch = document.createElementNS(SVG_NS, "svg");
          swatch.setAttribute("class", "lp-legend__dash");
          swatch.setAttribute("viewBox", "0 0 16 4");
          swatch.setAttribute("aria-hidden", "true");
          swatch.appendChild(el("line", {
            x1: 0, y1: 2, x2: 16, y2: 2,
            stroke: cssVar(o.tick ? "--z-ink" : "--z-ink-3"),
            "stroke-width": o.tick ? 2.5 : 1.5,
            "stroke-dasharray": o.tick ? "none" : o.dash,
            "stroke-opacity": o.opacity
          }));
        }

        var name = document.createElement("span");
        name.textContent = o.label;

        item.appendChild(swatch);
        item.appendChild(name);
        legend.appendChild(item);
      });

      card.appendChild(legend);
    }

    var body = document.createElement("div");
    body.className = "lp-card__body";
    body.appendChild(chart);

    var tableWrap = document.createElement("div");
    tableWrap.className = "lp-table-wrap";
    tableWrap.hidden = true;
    tableWrap.appendChild(buildTable(spec));
    body.appendChild(tableWrap);

    card.appendChild(body);

    toggle.addEventListener("click", function () {
      var on = toggle.getAttribute("aria-pressed") === "true";
      toggle.setAttribute("aria-pressed", String(!on));
      tableWrap.hidden = on;
      chart.hidden = !on;
      if (on) draw(chart);
      resizeWidget();
    });

    mount(chart, spec);
    return card;
  }

  /**
   * The table carries every number the overlays add, so nothing is reachable
   * only by hovering.
   */
  function buildTable(spec) {
    var table = document.createElement("table");
    table.className = "lp-table";

    var cols = [];
    spec.series.forEach(function (s) {
      cols.push({ name: s.name, values: s.values, format: s.format || spec.valueFormat });
      if (VIEW.compare && s.compare) {
        cols.push({
          name: s.name + " (last year)", values: s.compare,
          format: s.format || spec.valueFormat, soft: true
        });
      }
      if (VIEW.target && s.target) {
        cols.push({
          name: s.name + " (target)", values: s.target,
          format: s.format || spec.valueFormat, soft: true
        });
      }
    });

    var thead = document.createElement("thead");
    var hr = document.createElement("tr");
    var th0 = document.createElement("th");
    th0.scope = "col";
    th0.textContent = spec.xLabel || "Period";
    hr.appendChild(th0);

    cols.forEach(function (c) {
      var th = document.createElement("th");
      th.scope = "col";
      th.textContent = c.name;
      if (c.soft) th.className = "is-soft";
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    spec.labels.forEach(function (label, i) {
      var tr = document.createElement("tr");
      var td0 = document.createElement("th");
      td0.scope = "row";
      td0.textContent = label;
      td0.style.fontWeight = "500";
      tr.appendChild(td0);

      cols.forEach(function (c) {
        var td = document.createElement("td");
        td.textContent = formatter(c.format)(c.values[i]);
        if (c.soft) td.className = "is-soft";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  /* ---- 6.4 Series builder --------------------------------------------- */

  /**
   * Assemble one series, applying the brush window to the actuals and to
   * every overlay in step so they always line up.
   */
  function makeSeries(o, win, len) {
    var full = align(o.values, len);
    var s = {
      id: o.id,
      name: o.name,
      hue: o.hue,
      format: o.format,
      upIsGood: o.upIsGood,
      drill: o.drill,
      values: win ? slice(full, win) : full
    };

    if (o.compare) {
      var c = align(o.compare, len);
      s.compare = win ? slice(c, win) : c;
    }
    if (o.target != null) {
      var t = targetArray(o.target, len);
      s.target = win ? slice(t, win) : t;
    }
    return s;
  }

  /* ---- 6.5 Scorecard --------------------------------------------------- */

  function renderScorecard(d) {
    var host = document.getElementById("ytd-tiles");
    host.textContent = "";

    /* Row 2 of the whiteboard sits under its row-1 counterpart, so each
       column renders as one tile carrying a paired sub-metric. */
    var tiles = [
      { label: "New Prospects", key: "newProspects", format: "count",
        pair: { label: "< 5K Customers", key: "under5kCustomers", format: "count" } },
      { label: "Cross-Sell Prospects", key: "csProspects", format: "count",
        pair: { label: "> 5K Customers", key: "over5kCustomers", format: "count" } },
      { label: "New Customers", key: "newCustomers", format: "count",
        pair: { label: "New Revenue", key: "newRevenue", format: "currency" } },
      { label: "Cross-Sell Customers", key: "csCustomers", format: "count",
        pair: { label: "Cross-Sell Revenue", key: "csRevenue", format: "currency" } },
      { label: "Total Customers", key: "totalCustomers", format: "count",
        pair: { label: "Total Revenue", key: "totalRevenue", format: "currency" } },
      { label: "Conversion %", key: "convPct", format: "percent" }
    ];

    tiles.forEach(function (t) {
      var cfg = { label: t.label, format: t.format };
      if (t.pair) {
        cfg.pair = {
          label: t.pair.label,
          format: t.pair.format,
          value: d.ytd[t.pair.key]
        };
      }
      var tile = statTile(cfg, d.ytd[t.key], d.prev ? d.prev[t.key] : null);
      if (!t.pair) {
        var spacer = document.createElement("div");
        spacer.className = "lp-tile__spacer";
        tile.appendChild(spacer);
      }
      host.appendChild(tile);
    });

    document.getElementById("lp-ytd-note").textContent =
      "Cross-sell = CS · revenue band split at " + CONFIG.currency + "5K";
  }

  /* ---- 6.6 Trend sections --------------------------------------------- */

  function windowNote(win) {
    return win.all[win.start] + " – " + win.all[win.end];
  }

  function renderPerformance(d) {
    var host = document.getElementById("perf-charts");
    host.textContent = "";

    var win = windowFor(d.year);
    var len = win.all.length;
    var months = win.all.slice(win.start, win.end + 1);
    var ly = d.lastYear || {};

    /* Revenue, Customers and Leads do not share a unit — small multiples,
       one y-scale per panel. A single frame here would need two axes. */
    host.appendChild(chartCard({
      key: "monthly-performance",
      title: "Monthly performance",
      subtitle: windowNote(win) + " " + d.year +
        (VIEW.range ? " · zoomed" : " · year to date"),
      mode: "panels",
      types: PANEL_TYPES,
      defaultType: "panel-bar",
      zoomable: true,
      rangeBase: win.start,
      xLabel: "Month",
      labels: months,
      series: [
        makeSeries({
          id: "revenue", name: "Revenue", hue: HUE.revenue, format: "currency",
          values: d.monthly.revenue,
          compare: ly.monthly && ly.monthly.revenue,
          target: d.targets && d.targets.monthlyRevenue,
          drill: { module: "Deals", noun: "deals" }
        }, win, len),
        makeSeries({
          id: "customers", name: "Customers", hue: HUE.customers, format: "count",
          values: d.monthly.customers,
          compare: ly.monthly && ly.monthly.customers,
          target: d.targets && d.targets.monthlyCustomers,
          drill: { module: "Accounts", noun: "customers" }
        }, win, len),
        makeSeries({
          id: "leads", name: "Leads", hue: HUE.leads, format: "count",
          values: d.monthly.leads,
          compare: ly.monthly && ly.monthly.leads,
          drill: { module: "Leads", noun: "leads" }
        }, win, len)
      ]
    }));

    host.appendChild(chartCard({
      key: "quarterly-performance",
      title: "Quarterly performance",
      subtitle: "Q1 – Q4 " + d.year,
      mode: "panels",
      types: PANEL_TYPES,
      defaultType: "panel-bar",
      zoomable: false,           // quarters are not on the month axis
      xLabel: "Quarter",
      labels: QUARTERS,
      series: [
        makeSeries({
          id: "revenue", name: "Revenue", hue: HUE.revenue, format: "currency",
          values: d.quarterly.revenue,
          compare: ly.quarterly && ly.quarterly.revenue,
          target: d.targets && d.targets.quarterlyRevenue,
          drill: { module: "Deals", noun: "deals" }
        }, null, 4),
        makeSeries({
          id: "customers", name: "Customers", hue: HUE.customers, format: "count",
          values: d.quarterly.customers,
          compare: ly.quarterly && ly.quarterly.customers,
          drill: { module: "Accounts", noun: "customers" }
        }, null, 4),
        makeSeries({
          id: "leads", name: "Leads", hue: HUE.leads, format: "count",
          values: d.quarterly.leads,
          compare: ly.quarterly && ly.quarterly.leads,
          drill: { module: "Leads", noun: "leads" }
        }, null, 4)
      ]
    }));
  }

  function renderPipeline(d) {
    var host = document.getElementById("pipeline-tiles");
    host.textContent = "";

    var p = d.pipeline;
    var prev = d.prevPipeline || {};

    host.appendChild(statTile(
      { label: "Qualified Lost Customers", format: "count", upIsGood: false },
      p.qualifiedLostCustomers, prev.qualifiedLostCustomers
    ));

    host.appendChild(statTile(
      { label: "Lost Revenue", format: "currency", upIsGood: false },
      p.lostRevenue, prev.lostRevenue
    ));

    host.appendChild(statTile(
      { label: "Pipeline Revenue", format: "currency", note: "Q" + currentQuarter() + " " + d.year },
      p.pipelineRevenueQuarter, null
    ));

    host.appendChild(statTile(
      { label: "Pipeline Revenue", format: "currency", note: "FY " + d.year },
      p.pipelineRevenueYear, null
    ));

    /* Open pipeline whose close date has already passed. Growth here is
       bad news, so the tile flags the direction the other way round. */
    host.appendChild(statTile(
      { label: "Pipeline Overdue", format: "currency",
        note: "FY " + d.year, upIsGood: false },
      p.pipelineOverdue, null
    ));

    host.appendChild(meterTile(
      "Forecasted vs Attainment", p.forecastRevenue, p.attainedRevenue
    ));
  }

  function renderBookings(d) {
    var host = document.getElementById("bookings-charts");
    host.textContent = "";

    var win = windowFor(d.year);
    var len = win.all.length;
    var months = win.all.slice(win.start, win.end + 1);
    var ly = d.lastYear || {};

    /* Both series are customer counts — same unit, so one shared axis. */
    host.appendChild(chartCard({
      key: "bookings",
      title: "Churned vs booked customers",
      subtitle: "Number of customers churned from your bookings",
      mode: "overlay",
      types: SERIES_TYPES,
      defaultType: "bar",
      valueFormat: "count",
      zoomable: true,
      rangeBase: win.start,
      xLabel: "Month",
      labels: months,
      series: [
        makeSeries({
          id: "booked", name: "Booked customers", hue: HUE.booked,
          values: d.bookings.booked,
          compare: ly.bookings && ly.bookings.booked,
          drill: { module: "Accounts", noun: "booked customers" }
        }, win, len),
        makeSeries({
          id: "churned", name: "Churned customers", hue: HUE.churned,
          upIsGood: false,
          values: d.bookings.churned,
          compare: ly.bookings && ly.bookings.churned,
          drill: { module: "Accounts", noun: "churned customers" }
        }, win, len)
      ]
    }));

    /* All three are percentages — same unit, one axis. */
    host.appendChild(chartCard({
      key: "pse",
      title: "Monthly PSE's / closures",
      subtitle: "Share of closures, %",
      mode: "overlay",
      types: RATE_TYPES,
      defaultType: "line",
      valueFormat: "percent",
      zoomable: true,
      rangeBase: win.start,
      xLabel: "Month",
      labels: months,
      series: [
        makeSeries({
          id: "pse", name: "PSE's", hue: HUE.pse,
          values: d.pse.pse,
          compare: ly.pse && ly.pse.pse,
          target: d.targets && d.targets.pseClosureRate,
          drill: { module: "Deals", noun: "PSE closures" }
        }, win, len),
        makeSeries({
          id: "revenue", name: "Revenue", hue: HUE.revenue,
          values: d.pse.revenue,
          compare: ly.pse && ly.pse.revenue,
          drill: { module: "Deals", noun: "deals" }
        }, win, len),
        makeSeries({
          id: "customers", name: "Customers", hue: HUE.customers,
          values: d.pse.customers,
          compare: ly.pse && ly.pse.customers,
          drill: { module: "Accounts", noun: "customers" }
        }, win, len)
      ]
    }));
  }

  function renderChannel(d) {
    var host = document.getElementById("channel-charts");
    host.textContent = "";

    var win = windowFor(d.year);
    var len = win.all.length;
    var months = win.all.slice(win.start, win.end + 1);
    var ly = d.lastYear || {};

    /* Guided selling keeps slot 1 and self service slot 2 in BOTH charts —
       colour follows the entity, so the eye carries across the pair. */
    host.appendChild(chartCard({
      key: "channel-customers",
      title: "Guided selling vs self service — customers",
      subtitle: windowNote(win) + " " + d.year,
      mode: "overlay",
      types: MIX_TYPES,
      defaultType: "stacked",
      valueFormat: "count",
      zoomable: true,
      rangeBase: win.start,
      xLabel: "Month",
      labels: months,
      series: [
        makeSeries({
          id: "guided", name: "Guided selling customers", hue: HUE.guided,
          values: d.channel.guidedCustomers,
          compare: ly.channel && ly.channel.guidedCustomers,
          drill: { module: "Accounts", noun: "guided-selling customers" }
        }, win, len),
        makeSeries({
          id: "self", name: "Self service customers", hue: HUE.selfService,
          values: d.channel.selfServeCustomers,
          compare: ly.channel && ly.channel.selfServeCustomers,
          drill: { module: "Accounts", noun: "self-service customers" }
        }, win, len)
      ]
    }));

    host.appendChild(chartCard({
      key: "channel-revenue",
      title: "Guided selling vs self service — revenue",
      subtitle: windowNote(win) + " " + d.year,
      mode: "overlay",
      types: MIX_TYPES,
      defaultType: "stack-area",
      valueFormat: "currency",
      zoomable: true,
      rangeBase: win.start,
      xLabel: "Month",
      labels: months,
      series: [
        makeSeries({
          id: "guided", name: "Guided selling revenue", hue: HUE.guided,
          values: d.channel.guidedRevenue,
          compare: ly.channel && ly.channel.guidedRevenue,
          drill: { module: "Deals", noun: "guided-selling deals" }
        }, win, len),
        makeSeries({
          id: "self", name: "Self service revenue", hue: HUE.selfService,
          values: d.channel.selfServeRevenue,
          compare: ly.channel && ly.channel.selfServeRevenue,
          drill: { module: "Deals", noun: "self-service deals" }
        }, win, len)
      ]
    }));
  }

  /* ======================================================================
     7. Drill-through panel
     ====================================================================== */

  var drillState = { open: false, lastFocus: null };

  function openDrill(spec, live, index) {
    if (!CONFIG.enableDrill) return;

    var period = spec.labels[index];
    var primary = live[0];
    if (!primary) return;

    var panel = document.getElementById("lp-drill");
    var titleEl = document.getElementById("lp-drill-title");
    var subEl = document.getElementById("lp-drill-sub");
    var bodyEl = document.getElementById("lp-drill-body");

    drillState.lastFocus = document.activeElement;
    drillState.open = true;

    titleEl.textContent = period + " " + (state.year);
    subEl.textContent = spec.title;

    bodyEl.textContent = "";

    /* the numbers behind the point, before the records load */
    var summary = document.createElement("div");
    summary.className = "lp-drill__summary";
    live.forEach(function (s) {
      var f = formatter(s.format || spec.valueFormat);
      var row = document.createElement("div");
      row.className = "lp-drill__stat";

      var k = document.createElement("span");
      k.className = "lp-drill__key";
      k.style.background = cssVar(s.hue);

      var nm = document.createElement("span");
      nm.className = "lp-drill__stat-name";
      nm.textContent = s.name;

      var vv = document.createElement("span");
      vv.className = "lp-drill__stat-value";
      vv.textContent = f(s.values[index]);

      row.appendChild(k);
      row.appendChild(nm);
      row.appendChild(vv);
      summary.appendChild(row);
    });
    bodyEl.appendChild(summary);

    var listHead = document.createElement("div");
    listHead.className = "lp-drill__list-head";
    listHead.textContent = "Records";
    bodyEl.appendChild(listHead);

    var loading = document.createElement("div");
    loading.className = "lp-drill__empty";
    loading.textContent = "Loading records…";
    bodyEl.appendChild(loading);

    panel.hidden = false;
    document.getElementById("lp-scrim").hidden = false;
    document.getElementById("lp-drill-close").focus();

    fetchDrillRows(primary, period).then(function (rows) {
      if (!drillState.open) return;
      loading.remove();

      if (!rows.length) {
        var none = document.createElement("div");
        none.className = "lp-drill__empty";
        none.textContent = "No records matched this point.";
        bodyEl.appendChild(none);
        return;
      }

      var list = document.createElement("ul");
      list.className = "lp-drill__list";

      rows.forEach(function (r) {
        var li = document.createElement("li");
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "lp-drill__row";

        var nm = document.createElement("span");
        nm.className = "lp-drill__row-name";
        nm.textContent = r.name;              // untrusted -> textContent

        var meta = document.createElement("span");
        meta.className = "lp-drill__row-meta";
        meta.textContent = r.meta || "";

        var amt = document.createElement("span");
        amt.className = "lp-drill__row-amount";
        amt.textContent = r.amount || "";

        btn.appendChild(nm);
        btn.appendChild(meta);
        btn.appendChild(amt);

        btn.addEventListener("click", function () {
          if (window.ZOHO && ZOHO.CRM && ZOHO.CRM.UI && ZOHO.CRM.UI.Record && r.id) {
            ZOHO.CRM.UI.Record.open({ Entity: r.module, RecordID: r.id })
              .catch(function () { /* record may be deleted or not permitted */ });
          }
        });

        li.appendChild(btn);
        list.appendChild(li);
      });

      bodyEl.appendChild(list);
    }).catch(function (err) {
      if (!drillState.open) return;
      loading.className = "lp-drill__empty";
      loading.textContent = "Could not load records: " +
        (err && err.message ? err.message : err);
    });
  }

  function closeDrill() {
    drillState.open = false;
    document.getElementById("lp-drill").hidden = true;
    document.getElementById("lp-scrim").hidden = true;
    if (drillState.lastFocus && drillState.lastFocus.focus) {
      drillState.lastFocus.focus();
    }
  }

  /**
   * The records behind one point.
   *
   * WIRE ME: build a COQL query from the series' module + the period and run
   * it through ZOHO.CRM.API.coql. The criteria depends on your date fields,
   * so it is left to you:
   *
   *   return ZOHO.CRM.API.coql({ select_query:
   *     "select Deal_Name, Amount, Closing_Date from Deals " +
   *     "where Closing_Date between '" + from + "' and '" + to + "' limit 8"
   *   }).then(function (r) { return (r.data || []).map(toRow); });
   */
  function fetchDrillRows(series, period) {
    var mod = (series.drill && series.drill.module) || "Deals";

    if (!CONFIG.useMockData && window.ZOHO && ZOHO.CRM && ZOHO.CRM.API && ZOHO.CRM.API.coql) {
      return Promise.reject(new Error("drill-through query not wired — see fetchDrillRows()"));
    }

    /* sample rows so the interaction is demonstrable before wiring */
    var rnd = seeded(period.length * 7919 + mod.length * 31 + state.year);
    var firms = ["Northwind", "Acme Industrial", "Belmont Group", "Cirrus Labs",
                 "Dorset Retail", "Everline", "Fairmont Health", "Grayson Co"];
    var stages = ["Negotiation", "Proposal", "Qualification", "Closed Won"];
    var rows = [];

    for (var i = 0; i < Math.min(CONFIG.drillLimit, firms.length); i++) {
      rows.push({
        id: null,
        module: mod,
        name: firms[i],
        meta: stages[Math.floor(rnd() * stages.length)] + " · " + period,
        amount: fmtCurrency(Math.round(18000 + rnd() * 220000))
      });
    }
    return Promise.resolve(rows);
  }

  /* ======================================================================
     8. Boot & Zoho wiring
     ====================================================================== */

  var state = {
    year: new Date().getFullYear(),
    scope: "all",
    /* Multi-select filters are arrays. EMPTY means unconstrained ("All"),
       so "no filter" and "every box ticked" are not two spellings of the
       same thing. Year and scope stay single-valued: one month axis cannot
       serve two years, and the scope modes are mutually exclusive. */
    region: [],
    bu: [],
    service: [],
    buHead: [],
    manager: [],
    rep: []
  };
  var lastData = null;

  function setStatus(message, tone) {
    var bar = document.getElementById("lp-status");
    if (!message) { bar.hidden = true; return; }
    bar.textContent = message;
    bar.setAttribute("data-tone", tone || "info");
    bar.hidden = false;
  }

  function markStale(stale) {
    /* refetch keeps the frame: hold the previous render, dimmed */
    document.querySelectorAll(".lp-chart").forEach(function (c) {
      c.classList.toggle("is-stale", stale);
    });
    document.getElementById("lp-refresh").classList.toggle("is-busy", stale);
  }

  /** Rebuild every section from the data already in hand (no refetch). */
  function rerender() {
    if (!lastData) return;
    mounted.length = 0;

    renderScorecard(lastData);
    renderPerformance(lastData);
    renderPipeline(lastData);
    renderBookings(lastData);
    renderChannel(lastData);

    drawAll();
    syncZoomChip();
    resizeWidget();
  }

  function load() {
    markStale(true);

    return fetchData(state)
      .then(function (d) {
      lastData = d;
      VIEW.range = null;          // a new slice invalidates the old zoom

      /* name the active slice, so a filtered number is never mistaken for
         the whole org */
      var slice = [periodLabel(state.year)];
      /* name the active slice; several values collapse to "EMEA +2" so the
         header cannot grow unbounded */
      [state.region, state.bu, state.service].forEach(function (vals) {
        if (!vals.length) return;
        slice.push(vals.length === 1 ? vals[0] : vals[0] + " +" + (vals.length - 1));
      });

      var person = selectedPeopleLabel(state);
      if (person) {
        slice.push((state.rep || []).length === 1 ? person : person + "'s team");
      } else if (state.scope !== "all" && CRM.user) {
        slice.push(state.scope === "team" ? CRM.user.name + "'s team" : CRM.user.name);
      }
      document.getElementById("lp-period").textContent = slice.join("  ·  ");
      rerender();

      markStale(false);
      syncResetState();
      setStatus(
        CONFIG.useMockData
          ? "Showing sample data — wire Zoho Analytics in script.js § 4.2 and set CONFIG.useMockData = false."
          : null,
        "warn"
      );
    }).catch(function (err) {
      markStale(false);
      setStatus("Could not load data: " + (err && err.message ? err.message : err), "error");
    });
  }

  /** Re-label the header once we know who is signed in. */
  function renderViewer() {
    var el = document.getElementById("lp-period");
    if (el && CRM.user && state.scope !== "all") {
      el.textContent = el.textContent + "  ·  " + CRM.user.name;
    }
  }

  function syncZoomChip() {
    var chip = document.getElementById("lp-zoom-reset");
    if (!chip) return;
    if (!VIEW.range || !lastData) { chip.hidden = true; return; }
    var win = windowFor(lastData.year);
    chip.hidden = false;
    document.getElementById("lp-zoom-label").textContent =
      win.all[win.start] + "–" + win.all[win.end];
  }

  function resizeWidget() {
    if (!window.ZOHO || !ZOHO.CRM || !ZOHO.CRM.UI || !ZOHO.CRM.UI.Resize) return;
    var h = document.getElementById("lp-root").scrollHeight + 24;
    try { ZOHO.CRM.UI.Resize({ height: h + "px", width: "100%" }); } catch (e) { /* noop */ }
  }

  /**
   * Multi-select picklist: a button plus a popover of drawn checkboxes, with
   * bulk Select all / Clear all and a search box once the list is long
   * enough to need one. Returns a handle exposing setItems() and sync(), so
   * the people cascade can refill options and the master reset can re-label
   * without either rebuilding the control.
   *
   * An EMPTY selection means "all" — the unconstrained state, not an error.
   */
  function createPicklist(cfg) {
    var mount = document.getElementById(cfg.id);
    if (!mount) return null;

    mount.className = "lp-pick";
    mount.textContent = "";

    var items = cfg.items || [];
    var query = "";

    /* ---- trigger ---- */
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lp-pick__btn";
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-haspopup", "true");

    var text = document.createElement("span");
    text.className = "lp-pick__text";

    var count = document.createElement("span");
    count.className = "lp-pick__count";
    count.hidden = true;

    var caret = svgIcon("lp-pick__caret", "0 0 10 10", "M2 4l3 3 3-3");

    btn.appendChild(text);
    btn.appendChild(count);
    btn.appendChild(caret);

    /* ---- popover ---- */
    var menu = document.createElement("div");
    menu.className = "lp-pick__menu";
    menu.hidden = true;

    var searchWrap, searchInput, actAll, actNone, list, foot, footCount, footClear;

    function buildShell() {
      menu.textContent = "";

      if (items.length > 6) {
        searchWrap = document.createElement("div");
        searchWrap.className = "lp-pick__search";
        searchWrap.appendChild(svgIcon("", "0 0 14 14",
          "M6 1.5a4.5 4.5 0 1 0 2.9 7.95l3.1 3.1", true));

        searchInput = document.createElement("input");
        searchInput.type = "text";
        searchInput.placeholder = cfg.searchLabel || "Search";
        searchInput.value = query;
        searchInput.addEventListener("input", function () {
          query = searchInput.value;
          renderList();
        });
        searchWrap.appendChild(searchInput);
        menu.appendChild(searchWrap);
      }

      var actions = document.createElement("div");
      actions.className = "lp-pick__actions";

      actAll = document.createElement("button");
      actAll.type = "button";
      actAll.className = "lp-pick__act";
      actAll.textContent = "Select all";
      actAll.addEventListener("click", function () {
        commit(visible().map(function (i) { return i.value; }));
      });

      actNone = document.createElement("button");
      actNone.type = "button";
      actNone.className = "lp-pick__act";
      actNone.textContent = "Clear all";
      actNone.addEventListener("click", function () { commit([]); });

      actions.appendChild(actAll);
      actions.appendChild(actNone);
      menu.appendChild(actions);

      list = document.createElement("div");
      list.className = "lp-pick__list";
      menu.appendChild(list);

      foot = document.createElement("div");
      foot.className = "lp-pick__foot";
      footCount = document.createElement("span");
      footClear = document.createElement("span");
      foot.appendChild(footCount);
      foot.appendChild(footClear);
      menu.appendChild(foot);

      renderList();
    }

    function selected() { return state[cfg.key] || []; }

    function visible() {
      var q = query.trim().toLowerCase();
      if (!q) return items;
      return items.filter(function (i) {
        return i.label.toLowerCase().indexOf(q) !== -1;
      });
    }

    function renderList() {
      if (!list) return;
      list.textContent = "";

      var vis = visible();
      if (!vis.length) {
        var none = document.createElement("div");
        none.className = "lp-pick__empty";
        none.textContent = items.length
          ? "No match"
          : (cfg.emptyLabel || "Nothing to choose");
        list.appendChild(none);
      } else {
        vis.forEach(function (item) {
          list.appendChild(optionRow(item));
        });
      }

      var sel = selected().length;
      footCount.textContent = sel
        ? sel + " of " + items.length + " selected"
        : "Showing all " + items.length;
      footClear.textContent = "";

      var allVisibleOn = vis.length && vis.every(function (i) {
        return selected().indexOf(i.value) !== -1;
      });
      actAll.disabled = !vis.length || allVisibleOn;
      actNone.disabled = sel === 0;
    }

    function optionRow(item) {
      var on = selected().indexOf(item.value) !== -1;

      var row = document.createElement("label");
      row.className = "lp-pick__opt";
      row.setAttribute("data-on", String(on));

      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = on;
      box.addEventListener("change", function () {
        var next = selected().slice();
        var at = next.indexOf(item.value);
        if (box.checked && at === -1) next.push(item.value);
        if (!box.checked && at !== -1) next.splice(at, 1);
        commit(next);
      });

      var drawn = document.createElement("span");
      drawn.className = "lp-pick__check";
      drawn.setAttribute("aria-hidden", "true");
      drawn.appendChild(svgIcon("", "0 0 12 12", "M2.5 6.2l2.3 2.3L9.5 3.8"));

      var label = document.createElement("span");
      label.textContent = item.label;      // untrusted -> textContent

      row.appendChild(box);
      row.appendChild(drawn);
      row.appendChild(label);
      return row;
    }

    function summarise() {
      var sel = selected();
      btn.setAttribute("data-active", String(sel.length > 0));

      if (!sel.length) {
        text.textContent = cfg.allLabel;
        count.hidden = true;
        btn.removeAttribute("title");
        return;
      }

      var labelOf = function (v) {
        var m = items.filter(function (i) { return i.value === v; })[0];
        return m ? m.label : v;
      };
      text.textContent = labelOf(sel[0]);
      count.hidden = sel.length < 2;
      count.textContent = String(sel.length);
      btn.title = sel.map(labelOf).join(", ");
    }

    function commit(next) {
      state[cfg.key] = next;
      summarise();
      renderList();
      if (cfg.onChange) cfg.onChange(next);
    }

    function open() {
      closeAllPicklists();
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      btn.setAttribute("data-open", "true");
      query = "";
      buildShell();
      if (searchInput) searchInput.focus();
    }

    function close() {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      btn.removeAttribute("data-open");
    }

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (menu.hidden) open(); else close();
    });

    /* Clicks inside the popover must not reach the document handler that
       closes every picklist — otherwise ticking one box would shut the menu,
       which defeats the point of a multi-select. */
    menu.addEventListener("click", function (e) { e.stopPropagation(); });

    mount.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !menu.hidden) { close(); btn.focus(); }
    });

    mount.appendChild(btn);
    mount.appendChild(menu);

    var handle = {
      close: close,
      sync: summarise,
      setItems: function (next) {
        items = next || [];
        /* drop selections that no longer exist rather than filtering on an id
           the reader can neither see nor clear */
        var pruned = selected().filter(function (v) {
          return items.some(function (i) { return i.value === v; });
        });
        if (pruned.length !== selected().length) state[cfg.key] = pruned;
        summarise();
        if (!menu.hidden) buildShell();
      }
    };

    PICKLISTS.push(handle);
    summarise();
    return handle;
  }

  /** Small inline icon helper for the control chrome. */
  function svgIcon(cls, viewBox, path, noFillRule) {
    var svg = document.createElementNS(SVG_NS, "svg");
    if (cls) svg.setAttribute("class", cls);
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("aria-hidden", "true");
    svg.appendChild(el("path", {
      d: path, fill: "none", stroke: "currentColor",
      "stroke-width": noFillRule ? 1.4 : 1.8,
      "stroke-linecap": "round", "stroke-linejoin": "round"
    }));
    return svg;
  }

  var PICKLISTS = [];

  function closeAllPicklists() {
    PICKLISTS.forEach(function (p) { p.close(); });
  }

  document.addEventListener("click", closeAllPicklists);

  var DIM_PICKS = {};
  var ANALYSIS_CHIPS = {};
  var DIMENSION_KEYS = ["region", "bu", "service", "buHead", "manager", "rep"];

  /** Is anything actually narrowed or overlaid right now? */
  function anythingActive() {
    if (state.scope !== "all") return true;
    if (state.year !== new Date().getFullYear()) return true;
    if (VIEW.compare || VIEW.target || VIEW.trend || VIEW.range) return true;
    return DIMENSION_KEYS.some(function (k) { return (state[k] || []).length > 0; });
  }

  function syncResetState() {
    var btn = document.getElementById("lp-reset");
    if (btn) btn.disabled = !anythingActive();
  }

  /**
   * Master reset: every filter, overlay and zoom back to the default view.
   * Deliberately leaves each card's chosen chart form alone — that is the
   * reader's display preference, not a filter hiding data from them.
   */
  function resetAll() {
    state.year = new Date().getFullYear();
    state.scope = "all";
    DIMENSION_KEYS.forEach(function (k) { state[k] = []; });

    VIEW.compare = false;
    VIEW.target = false;
    VIEW.trend = false;
    VIEW.range = null;

    var yearSel = document.getElementById("lp-year");
    if (yearSel) yearSel.value = String(state.year);
    var scopeSel = document.getElementById("lp-scope");
    if (scopeSel) scopeSel.value = "all";

    Object.keys(ANALYSIS_CHIPS).forEach(function (k) {
      ANALYSIS_CHIPS[k].setAttribute("aria-pressed", "false");
    });

    closeAllPicklists();
    Object.keys(DIM_PICKS).forEach(function (k) {
      if (DIM_PICKS[k]) DIM_PICKS[k].sync();
    });
    populatePeopleSelects();

    syncResetState();
    load();
  }

  function initFilters() {
    var yearSel = document.getElementById("lp-year");
    var thisYear = new Date().getFullYear();
    for (var y = thisYear; y > thisYear - CONFIG.yearsBack; y--) {
      var opt = document.createElement("option");
      opt.value = String(y);
      opt.textContent = String(y);
      yearSel.appendChild(opt);
    }
    yearSel.value = String(state.year);

    yearSel.addEventListener("change", function () {
      state.year = parseInt(yearSel.value, 10);
      syncResetState();
      load();
    });

    document.getElementById("lp-scope").addEventListener("change", function (e) {
      state.scope = e.target.value;
      syncResetState();
      load();
    });

    document.getElementById("lp-reset").addEventListener("click", resetAll);

    /* Dimension picklists. Like every filter in this row they scope
       EVERYTHING below them, so a change refetches and every card re-renders
       against the same slice — the numbers can never disagree. */
    [["lp-region",  "region",  CONFIG.regions,       "All regions"],
     ["lp-bu",      "bu",      CONFIG.businessUnits, "All BUs"],
     ["lp-service", "service", CONFIG.services,      "All services"]]
      .forEach(function (cfg) {
        DIM_PICKS[cfg[1]] = createPicklist({
          id: cfg[0],
          key: cfg[1],
          allLabel: cfg[3],
          items: (cfg[2] || []).map(function (n) { return { value: n, label: n }; }),
          searchLabel: "Search " + cfg[1],
          onChange: function () { syncResetState(); load(); }
        });
      });

    document.getElementById("lp-refresh").addEventListener("click", load);

    /* analysis toggles — they scope every chart below them */
    [["lp-t-compare", "compare"], ["lp-t-target", "target"], ["lp-t-trend", "trend"]]
      .forEach(function (pair) {
        var btn = document.getElementById(pair[0]);
        if (!btn) return;
        ANALYSIS_CHIPS[pair[1]] = btn;
        btn.addEventListener("click", function () {
          VIEW[pair[1]] = !VIEW[pair[1]];
          btn.setAttribute("aria-pressed", String(VIEW[pair[1]]));
          syncResetState();
          rerender();
        });
      });

    /* Choosing a higher tier invalidates the tiers below it, so clear them
       rather than leaving a rep selected who no longer sits under any chosen
       manager. */
    [["lp-buhead",  "buHead",  "All BU heads", ["manager", "rep"]],
     ["lp-manager", "manager", "All managers", ["rep"]],
     ["lp-rep",     "rep",     "All reps",     []]].forEach(function (cfg) {
      PEOPLE_PICKS[cfg[1]] = createPicklist({
        id: cfg[0],
        key: cfg[1],
        allLabel: cfg[2],
        items: [],
        emptyLabel: "No one under this selection",
        onChange: function () {
          cfg[3].forEach(function (k) { state[k] = []; });
          populatePeopleSelects();
          syncResetState();
          load();
        }
      });
    });

    document.getElementById("lp-zoom-reset").addEventListener("click", function () {
      VIEW.range = null;
      rerender();
    });

    document.getElementById("lp-drill-close").addEventListener("click", closeDrill);
    document.getElementById("lp-scrim").addEventListener("click", closeDrill);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && drillState.open) closeDrill();
    });
  }

  /**
   * A small synthetic org so the people filters work when there is no CRM
   * session — opened standalone, or on GitHub Pages. Two BU heads, two
   * managers each, three reps each.
   */
  function mockPeople() {
    var org = [
      ["Anita Rao",      ["Priya Menon",   ["Karan Shah", "Leena Iyer", "Omar Faruk"],
                          "Daniel Whitby", ["Ravi Kulkarni", "Sara Lindqvist", "Tom Alvarez"]]],
      ["David Osei",     ["Grace Nkemdi",  ["Hema Prasad", "Ian Brodie", "Jules Marchand"],
                          "Nadia Haddad",  ["Peter Novak", "Rosa Ibarra", "Yusuf Demir"]]]
    ];
    var users = [];
    var email = function (n) {
      return n.toLowerCase().replace(/[^a-z]+/g, ".") + "@example.com";
    };

    org.forEach(function (head, hi) {
      var headId = "h" + hi;
      users.push({ id: headId, name: head[0], email: email(head[0]),
                   role: "BU Head", managerId: null });

      for (var i = 0; i < head[1].length; i += 2) {
        var mName = head[1][i], reps = head[1][i + 1];
        var mId = headId + "m" + i;
        users.push({ id: mId, name: mName, email: email(mName),
                     role: "Sales Manager", managerId: headId });
        reps.forEach(function (rName, ri) {
          users.push({ id: mId + "r" + ri, name: rName, email: email(rName),
                       role: "Sales Rep", managerId: mId });
        });
      }
    });
    return users;
  }

  /** Direct reports of the signed-in user, plus themselves. */
  function computeTeam() {
    CRM.teamEmails = [];
    if (!CRM.user) return;
    var me = CRM.people.byId[String(CRM.user.id)];
    if (me) CRM.teamEmails = emailsUnder(me.id);
    if (CRM.user.email && CRM.teamEmails.indexOf(CRM.user.email) === -1) {
      CRM.teamEmails.push(CRM.user.email);
    }
  }

  /**
   * Populate the reporting tree. Falls back to the synthetic org whenever CRM
   * users are unavailable, so the filters are never dead controls.
   */
  function ensurePeople() {
    if (window.ZOHO && ZOHO.CRM && ZOHO.CRM.API && ZOHO.CRM.API.getAllUsers) {
      return ZOHO.CRM.API.getAllUsers({ Type: "ActiveUsers" }).then(function (r) {
        var users = ((r && r.users) || []).map(function (u) {
          return {
            id: String(u.id),
            name: u.full_name || u.name,
            email: u.email,
            role: u.role && u.role.name,
            managerId: u.Reporting_To ? String(u.Reporting_To.id) : null
          };
        }).filter(function (u) { return u.email; });

        buildHierarchy(users.length ? users : mockPeople());
        return CRM.people;
      }).catch(function () {
        buildHierarchy(mockPeople());
        return CRM.people;
      });
    }
    buildHierarchy(mockPeople());
    return Promise.resolve(CRM.people);
  }

  /**
   * Refill the three people picklists. Each tier is narrowed by the union of
   * the subtrees selected above it, so the lists only ever offer people who
   * actually sit under the current selection.
   */
  var PEOPLE_PICKS = {};

  function populatePeopleSelects() {
    var P = CRM.people;

    var unionSubtrees = function (ids) {
      var out = [];
      ids.forEach(function (id) {
        subtreeIds(id).forEach(function (x) {
          if (out.indexOf(x) === -1) out.push(x);
        });
      });
      return out;
    };

    var allowedMgr = state.buHead.length ? unionSubtrees(state.buHead) : null;
    var managers = P.managers.filter(function (id) {
      return !allowedMgr || allowedMgr.indexOf(id) !== -1;
    });

    var repRoots = state.manager.length ? state.manager
                 : state.buHead.length ? state.buHead : null;
    var allowedRep = repRoots ? unionSubtrees(repRoots) : null;
    var reps = P.reps.filter(function (id) {
      return !allowedRep || allowedRep.indexOf(id) !== -1;
    });

    var toItems = function (ids) {
      return ids.map(function (id) {
        return { value: id, label: (CRM.people.byId[id] || {}).name || id };
      });
    };

    if (PEOPLE_PICKS.buHead) PEOPLE_PICKS.buHead.setItems(toItems(P.buHeads));
    if (PEOPLE_PICKS.manager) PEOPLE_PICKS.manager.setItems(toItems(managers));
    if (PEOPLE_PICKS.rep) PEOPLE_PICKS.rep.setItems(toItems(reps));
  }

  var booted = false;

  function boot() {
    if (booted) return;
    booted = true;
    initFilters();
    load();

    /* the people lists need the reporting tree, but the dashboard must not
       wait on it — outside CRM this resolves synchronously anyway */
    ensurePeople().then(populatePeopleSelects);
  }

  /**
   * Adopt the org's currency symbol once CRM reports it. The dashboard has
   * already painted by this point, so a difference costs one cheap re-render
   * instead of holding up the whole first paint.
   */
  function adoptOrgCurrency() {
    if (!window.ZOHO || !ZOHO.CRM || !ZOHO.CRM.CONFIG ||
        !ZOHO.CRM.CONFIG.getOrgInfo) return;

    ZOHO.CRM.CONFIG.getOrgInfo().then(function (org) {
      var sym = org && org.__zoho_crm_org && org.__zoho_crm_org.currency_symbol;
      if (sym && sym !== CONFIG.currency) {
        CONFIG.currency = sym;
        rerender();
      }
    }).catch(function () { /* keep the default */ });
  }

  /**
   * The SDK is loaded async, so it may land after this file runs. Poll
   * briefly for it rather than blocking on it, and give up quietly when it
   * never arrives — which is the normal case outside CRM.
   */
  function whenSdkReady(cb) {
    var tries = 0;
    (function look() {
      if (window.ZOHO && ZOHO.embeddedApp) return cb();
      if (++tries > 50) return;            // ~5s, then stop looking
      setTimeout(look, 100);
    })();
  }

  document.addEventListener("DOMContentLoaded", function () {
    /* Paint first, always. This used to wait for the CRM PageLoad event with
       a 1.5s fallback behind it, so every load outside CRM — GitHub Pages, a
       local file open — showed an empty shell for that full delay before
       anything appeared. Nothing in the first render needs the SDK. */
    boot();

    whenSdkReady(function () {
      ZOHO.embeddedApp.on("PageLoad", function () {
        adoptOrgCurrency();

        /* Who is signed in decides what "My records" and "My team" mean, so
           resolve it and reload if a user-scoped filter is already active.
           The dashboard has already painted by now — this refines it. */
        loadCurrentUser().then(function (user) {
          if (user) renderViewer();
          return ensurePeople();
        }).then(function () {
          computeTeam();
          populatePeopleSelects();
          /* only refetch if a people-scoped filter is actually in play */
          if (state.scope !== "all") load();
        });

        resizeWidget();
      });
      try { ZOHO.embeddedApp.init(); } catch (e) { /* not inside CRM */ }
    });
  });

})();
