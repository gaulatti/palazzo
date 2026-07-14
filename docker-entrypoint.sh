#!/bin/sh
# docker-entrypoint.sh
#
# First-stage entrypoint for the Palazzo container.
# 1. Generates an Icecast2 XML configuration from environment variables.
# 2. Starts Icecast2 in the background.
# 3. Execs the Node.js API server (passed via CMD).
set -e

# Defaults for Icecast configuration.
ICECAST_PORT="${ICECAST_PORT:-8000}"
PASS="${ICECAST_SOURCE_PASSWORD:-palazzo-source}"

# Write Icecast config — all authentication uses the same password
# and CORS is wide-open so browser-based clients can connect.
cat > /etc/icecast2/icecast.xml << EOF
<icecast>
    <location>Earth</location>
    <admin>admin@localhost</admin>
    <hostname>localhost</hostname>
    <limits>
        <clients>100</clients>
        <sources>2</sources>
        <queue-size>524288</queue-size>
        <client-timeout>30</client-timeout>
        <header-timeout>15</header-timeout>
        <source-timeout>10</source-timeout>
        <burst-on-connect>1</burst-on-connect>
        <burst-size>65535</burst-size>
    </limits>
    <authentication>
        <source-password>${PASS}</source-password>
        <relay-password>${PASS}</relay-password>
        <admin-user>admin</admin-user>
        <admin-password>${PASS}</admin-password>
    </authentication>
    <listen-socket>
        <port>${ICECAST_PORT}</port>
    </listen-socket>
    <http-headers>
        <header name="Access-Control-Allow-Origin" value="*" />
    </http-headers>
    <fileserve>1</fileserve>
    <paths>
        <basedir>/usr/share/icecast2</basedir>
        <logdir>/var/log/icecast2</logdir>
        <webroot>/usr/share/icecast2/web</webroot>
        <adminroot>/usr/share/icecast2/admin</adminroot>
        <alias source="/" destination="/status.xsl"/>
    </paths>
    <logging>
        <accesslog>access.log</accesslog>
        <errorlog>error.log</errorlog>
        <loglevel>3</loglevel>
        <logsize>10000</logsize>
    </logging>
    <security>
        <chroot>0</chroot>
        <changeowner>
            <user>icecast2</user>
            <group>icecast</group>
        </changeowner>
    </security>
</icecast>
EOF

# Start Icecast in the background.
icecast2 -c /etc/icecast2/icecast.xml -b
echo "Icecast started on port ${ICECAST_PORT}"

# Hand control to the Node.js process.
exec "$@"
