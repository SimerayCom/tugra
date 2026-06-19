import apps from "./apps.json";
import auth from "./auth.json";
import bulk from "./bulk.json";
import common from "./common.json";
import dashboard from "./dashboard.json";
import databases from "./databases.json";
import destinations from "./destinations.json";
import monitors from "./monitors.json";
import nav from "./nav.json";
import servers from "./servers.json";
import settings from "./settings.json";
import shared from "./shared.json";
import terminal from "./terminal.json";

// Split into namespace files (this JSON gets large); merged here.
const en = { apps, auth, bulk, common, dashboard, databases, destinations, monitors, nav, servers, settings, shared, terminal };

export default en;
