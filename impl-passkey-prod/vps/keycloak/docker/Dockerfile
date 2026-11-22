FROM quay.io/keycloak/keycloak:26.8.2

# White-label login theme: German text, portal branding, no "Keycloak" wording.
COPY theme/vw /opt/keycloak/themes/vw

# `vault` is a build-time option. Building it into the image keeps startup
# fast and consistent; secrets are read from /opt/keycloak/vault at runtime.
RUN /opt/keycloak/bin/kc.sh build --vault=file
