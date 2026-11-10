# Traffic Analytics: IP geolocation

Traffic Analytics shows where requests come from (country, and optionally city) without any setup.
The Tugra agent resolves the client address against a **local** database file. Nothing is looked up
online and nothing is downloaded at runtime.

## Built in: country geo

The agent image ships with the free [DB-IP](https://db-ip.com) Lite Country database
(`/usr/share/tugra/geoip/country.mmdb`, CC BY 4.0, see [NOTICE](../NOTICE)). It is fetched once, when
the image is built, so country breakdowns work out of the box. If that download was not possible at
build time, the image still works and country simply reads as unknown.

## Optional: city-level data

Drop a City-edition database in MaxMind `.mmdb` format (for example DB-IP Lite City or GeoLite2 City)
on the server running the agent at:

```
/etc/tugra/geoip/city.mmdb
```

then restart the agent. City data is only shown when the databases and your server's IP privacy
setting allow it. To use a different location, set `TUGRA_GEOIP_DB` to the file's path in the agent's
environment.

## Lookup order

The agent opens the first file in this list that exists and is a valid database:

1. `TUGRA_GEOIP_DB` (if set)
2. `/etc/tugra/geoip/city.mmdb` (operator-supplied City edition)
3. `/etc/tugra/geoip/country.mmdb` (operator-supplied country database)
4. `/usr/share/tugra/geoip/country.mmdb` (baked-in DB-IP Lite Country)

With none present, geo is empty and everything else keeps working.

## Refreshing the data

IP data drifts, and DB-IP publishes a new Lite file each month.

- **Baked-in database:** pull a newer agent image, or rebuild it with a newer file:
  `docker build --build-arg DBIP_COUNTRY_URL=https://download.db-ip.com/free/dbip-country-lite-YYYY-MM.mmdb.gz -f deploy/Dockerfile.agent .`
- **Your own database:** replace the `.mmdb` file in `/etc/tugra/geoip/` and restart the agent.
