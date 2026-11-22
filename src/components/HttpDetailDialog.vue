<template>
    <div ref="modal" class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">
                        {{ $t("Details") }}
                    </h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                </div>
                <div class="modal-body">
                    <div v-if="loading">{{ $t("Loading...") }}</div>
                    <div v-else-if="errorMsg" class="text-danger">{{ errorMsg }}</div>
                    <div v-else-if="detail">
                        <div v-for="(block, index) in blocks" :key="index" :class="{ 'mt-4': index > 0 }">
                            <h6 v-if="block.title">{{ block.title }}</h6>

                            <div v-if="block.peer" class="mb-3">
                                <Status :status="block.peer.status" />
                                {{ block.peer.msg }}
                                <span v-if="block.peer.ping != null">({{ $t("Ping") }}: {{ block.peer.ping }} ms)</span>
                            </div>

                            <div v-if="block.detail">
                                <div class="mb-3">
                                    <strong>{{ $t("httpDetailSentTo") }}</strong>
                                    <div>{{ sentTo(block.detail) }}</div>
                                </div>

                                <div class="mb-3">
                                    <strong>{{ $t("httpDetailRequest") }}</strong>
                                    <div>{{ block.detail.request.method }} {{ block.detail.request.url }}</div>
                                </div>

                                <div v-if="requestHeaders(block.detail)" class="mb-3">
                                    <strong>{{ $t("httpDetailRequestHeaders") }}</strong>
                                    <pre class="detail-pre">{{ requestHeaders(block.detail) }}</pre>
                                </div>

                                <div class="mb-3">
                                    <strong>{{ $t("Response") }}</strong>
                                    <div v-if="block.detail.response">
                                        {{ block.detail.response.status }} {{ block.detail.response.statusText }}
                                    </div>
                                    <div v-else>
                                        {{ $t("httpDetailNoResponse") }}
                                        <span v-if="block.detail.error">: {{ errorText(block.detail) }}</span>
                                    </div>
                                </div>

                                <div v-if="responseHeaders(block.detail)" class="mb-3">
                                    <strong>{{ $t("httpDetailResponseHeaders") }}</strong>
                                    <pre class="detail-pre">{{ responseHeaders(block.detail) }}</pre>
                                </div>

                                <div v-if="block.detail.body">
                                    <strong>{{ $t("Body") }}</strong>
                                    <pre class="detail-pre">{{ block.detail.body }}</pre>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div v-else-if="legacyBody">
                        <strong>{{ $t("Body") }}</strong>
                        <pre class="detail-pre">{{ legacyBody }}</pre>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { Modal } from "bootstrap";
import Status from "./Status.vue";

/**
 * Format headers as one "name: value" line each.
 * @param {object} headers Headers object
 * @returns {string} Text, empty if there are no headers
 */
function formatHeaders(headers) {
    return Object.entries(headers || {})
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n");
}

export default {
    components: {
        Status,
    },
    data() {
        return {
            modal: null,
            loading: false,
            errorMsg: "",
            detail: null,
            legacyBody: null,
        };
    },
    computed: {
        blocks() {
            const blocks = [{ title: this.detail.peer ? this.$t("forkThisInstance") : "", detail: this.detail }];
            if (this.detail.peer) {
                blocks.push({
                    title: this.$t("forkPeerCheck"),
                    peer: this.detail.peer,
                    detail: this.detail.peer.detail,
                });
            }
            return blocks;
        },
    },
    mounted() {
        this.modal = new Modal(this.$refs.modal);
    },
    methods: {
        /**
         * Address the request was sent to.
         * @param {object} detail Detail object
         * @returns {string} Host and port, or "unknown"
         */
        sentTo(detail) {
            if (!detail.ip) {
                return this.$t("httpDetailUnknown");
            }
            const host = detail.ip.includes(":") ? `[${detail.ip}]` : detail.ip;
            return detail.port ? `${host}:${detail.port}` : host;
        },
        requestHeaders(detail) {
            return formatHeaders(detail.request.headers);
        },
        responseHeaders(detail) {
            return formatHeaders(detail.response?.headers);
        },
        errorText(detail) {
            return [detail.error.code, detail.error.message].filter(Boolean).join(" ");
        },
        /**
         * Open the dialog and load the saved request and response of one heartbeat.
         * @param {number} monitorID Monitor ID
         * @param {string} time Heartbeat time
         * @returns {void}
         */
        show(monitorID, time) {
            this.loading = true;
            this.errorMsg = "";
            this.detail = null;
            this.legacyBody = null;
            this.modal.show();

            this.$root.getSocket().emit("getHeartbeatDetail", monitorID, time, (res) => {
                this.loading = false;
                if (res.ok) {
                    this.detail = res.detail;
                    this.legacyBody = res.body;
                } else {
                    this.errorMsg = res.msg;
                }
            });
        },
    },
};
</script>

<style lang="scss" scoped>
.detail-pre {
    max-height: 300px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
    margin-bottom: 0;
}
</style>
