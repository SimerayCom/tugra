import auth from "./auth.json";
import bulk from "./bulk.json";
import common from "./common.json";
import dashboard from "./dashboard.json";
import monitors from "./monitors.json";
import nav from "./nav.json";
import servers from "./servers.json";
import settings from "./settings.json";

// Split into namespace files (this JSON gets large); merged here.
const en = { auth, bulk, common, dashboard, monitors, nav, servers, settings };

export default en;
