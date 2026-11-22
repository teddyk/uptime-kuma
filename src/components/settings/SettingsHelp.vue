<template>
    <div class="settings-help" role="note">
        <slot>{{ text }}</slot>
    </div>
</template>

<script>
export default {
    props: {
        /** Help text, used when no slot content is given */
        text: {
            type: String,
            default: "",
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../assets/vars.scss";

.settings-help {
    margin-top: 1.5rem;
    padding: 0.75rem 1rem;
    font-size: 0.9rem;
    color: #495057;
    background-color: rgba(0, 0, 0, 0.04);
    border-left: 4px solid $primary;
    border-radius: 0.5rem;

    .dark & {
        color: $dark-font-color;
        background-color: rgba(255, 255, 255, 0.05);
    }
}
</style>
