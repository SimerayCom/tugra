import apps from "./apps.json";
import audit from "./audit.json";
import auth from "./auth.json";
import bulk from "./bulk.json";
import common from "./common.json";
import dashboard from "./dashboard.json";
import databases from "./databases.json";
import logdrains from "./logdrains.json";
import destinations from "./destinations.json";
import domains from "./domains.json";
import monitors from "./monitors.json";
import nav from "./nav.json";
import notifications from "./notifications.json";
import patching from "./patching.json";
import projects from "./projects.json";
import resources from "./resources.json";
import servers from "./servers.json";
import settings from "./settings.json";
import sources from "./sources.json";
import shared from "./shared.json";
import tags from "./tags.json";
import teams from "./teams.json";
import templates from "./templates.json";
import terminal from "./terminal.json";

// Split into namespace files (this JSON gets large); merged here.
const en = { apps, audit, auth, bulk, common, dashboard, databases, destinations, domains, logdrains, monitors, nav, notifications, patching, projects, resources, servers, settings, sources, shared, tags, teams, templates, terminal };

export default en;
