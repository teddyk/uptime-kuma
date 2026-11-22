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
                        <div class="mb-3">
                            <strong>{{ $t("httpDetailSentTo") }}</strong>
                            <div>{{ sentTo }}</div>
                        </div>

                        <div class="mb-3">
                            <strong>{{ $t("httpDetailRequest") }}</strong>
                            <div>{{ detail.request.method }} {{ detail.request.url }}</div>
                        </div>

                        <div v-if="requestHeaders" class="mb-3">
                            <strong>{{ $t("httpDetailRequestHeaders") }}</strong>
                            <pre class="detail-pre">{{ requestHeaders }}</pre>
                        </div>

                        <div class="mb-3">
                            <strong>{{ $t("Response") }}</strong>
                            <div v-if="detail.response">
                                {{ detail.response.status }} {{ detail.response.statusText }}
                            </div>
                            <div v-else>
                                {{ $t("httpDetailNoResponse") }}<span v-if="detail.error">: {{ errorText }}</span>
                            </div>
                        </div>

                        <div v-if="responseHeaders" class="mb-3">
                            <strong>{{ $t("httpDetailResponseHeaders") }}</strong>
                            <pre class="detail-pre">{{ responseHeaders }}</pre>
                        </div>

                        <div v-if="detail.body">
                            <strong>{{ $t("Body") }}</strong>
                            <pre class="detail-pre">{{ detail.body }}</pre>
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
        sentTo() {
            if (!this.detail.ip) {
                return this.$t("httpDetailUnknown");
            }
            const host = this.detail.ip.includes(":") ? `[${this.detail.ip}]` : this.detail.ip;
            return this.detail.port ? `${host}:${this.detail.port}` : host;
        },
        requestHeaders() {
            return formatHeaders(this.detail.request.headers);
        },
        responseHeaders() {
            return formatHeaders(this.detail.response?.headers);
        },
        errorText() {
            return [this.detail.error.code, this.detail.error.message].filter(Boolean).join(" ");
        },
    },
    mounted() {
        this.modal = new Modal(this.$refs.modal);
    },
    methods: {
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
