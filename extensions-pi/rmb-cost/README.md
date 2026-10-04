# rmb-cost

Shows the footer's session cost in RMB instead of USD.

The built-in footer hardcodes the cost as `$<total>` with no formatting hook, so
this wraps the public `FooterComponent.prototype.render` and rewrites the `$…`
token on the stats line into `¥…`, leaving the rest of the footer untouched.

The rate is a rough constant; update it when it drifts too far from spot. If
upstream changes the footer layout the replacement simply stops matching — it
will not crash. `/session` and other cost displays are unaffected and still show
USD.
