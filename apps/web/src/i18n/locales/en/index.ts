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
import errors from "./errors.json";
import home from "./home.json";
import monitors from "./monitors.json";
import nav from "./nav.json";
import notifications from "./notifications.json";
import onboarding from "./onboarding.json";
import patching from "./patching.json";
import projects from "./projects.json";
import registries from "./registries.json";
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
const en = { apps, audit, auth, bulk, common, dashboard, databases, destinations, domains, errors, home, logdrains, monitors, nav, notifications, onboarding, patching, projects, registries, resources, servers, settings, sources, shared, tags, teams, templates, terminal };

export default en;
