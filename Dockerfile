# syntax=docker/dockerfile:1
ARG UPSTREAM_IMAGE=memoriesoftime/nukkit-mot:latest

# The agent is platform-independent; build it once on the builder's architecture.
FROM --platform=$BUILDPLATFORM maven:3.9-eclipse-temurin-21 AS agent-build
WORKDIR /build
COPY pom.xml ./
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn --batch-mode --no-transfer-progress verify

FROM scratch AS agent-artifacts
COPY --from=agent-build /build/target/nukkit-mot-javaagent.jar /nukkit-mot-javaagent.jar

FROM ${UPSTREAM_IMAGE} AS runtime
COPY --from=agent-build --chmod=0444 /build/target/nukkit-mot-javaagent.jar /opt/nukkit-agent.jar
ENV JAVA_TOOL_OPTIONS="-javaagent:/opt/nukkit-agent.jar"
LABEL org.opencontainers.image.title="Nukkit-MOT with GitHub palette downloads" \
      org.opencontainers.image.description="Nukkit-MOT with an HTTP client agent redirecting bin-data.nkmot.com to GitHub" \
      org.opencontainers.image.source="https://github.com/SculkDev/NukkitMOT-GitHubRegistry"

# Exercise the actual upstream JRE on each target architecture before publishing.
FROM runtime AS runtime-test
COPY --from=agent-build /build/target/test-classes /tmp/agent-tests
RUN java -Xverify:all -cp /tmp/agent-tests com.memoriesoftime.agent.AgentProbe true \
    && printf 'Agent verified on upstream JRE\n' > /tmp/nukkit-agent-verified

# Referencing runtime-test makes its checks mandatory, without shipping the tests.
# USER, WORKDIR, ENTRYPOINT, ports and /data volume are inherited from upstream.
FROM runtime AS final
COPY --from=runtime-test /tmp/nukkit-agent-verified /opt/nukkit-agent-verified.txt
