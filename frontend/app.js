// Keep It Frontend Application
// Each feature in app/ returns its part of the one object Alpine runs.

// Descriptors, not a spread: a spread would run each getter once and keep the value.
function mergeFeatures(...features) {
    const app = {};
    for (const feature of features) {
        for (const name of Object.keys(feature)) {
            if (name in app) throw new Error(`${name} is defined by two features`);
        }
        Object.defineProperties(app, Object.getOwnPropertyDescriptors(feature));
    }
    return app;
}

function noteApp() {
    return mergeFeatures(
        coreFeature(),
        settingsFeature(),
        treeFeature(),
        tagsFeature(),
        mediaFeature(),
        drawingFeature(),
        editorFeature(),
        notesFeature(),
        createFeature(),
        searchFeature(),
        metadataFeature(),
        shareFeature(),
        homeFeature(),
        shareTargetFeature(),
        graphFeature(),
        sessionFeature(),
        viewerFeature(),
    );
}
