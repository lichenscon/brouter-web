/**
 * Provides track analysis functionality.
 *
 * Takes the detailed way tags from brouter-server's response
 * and creates tables with distributions of way types, surfaces,
 * and smoothness values.
 *
 * On hovering/click a table row the corresponding track segments
 * are highlighted on the map.
 *
 * @type {L.Class}
 */
BR.TrackAnalysis = L.Class.extend({
    /**
     * @type {Object}
     */
    options: {
        overlayStyle: {
            color: 'yellow',
            opacity: 0.8,
            weight: 8,
            // show above quality coding (pane defined in RoutingPathQuality.js)
            pane: 'routingQualityPane',
        },
    },

    /**
     * The total distance of the whole track, recalculate on each `update()` call.
     *
     * @type {float}
     */
    totalRouteDistance: 0.0,

    /**
     * @param {Map} map
     * @param {object} options
     */
    initialize(map, options) {
        this.map = map;
        L.setOptions(this, options);
    },

    /**
     * @type {?BR.TrackEdges}
     */
    trackEdges: null,

    /**
     * @type {?L.Polyline}
     */
    trackPolyline: null,

    /**
     * true when tab is shown, false when hidden
     *
     * @type {boolean}
     */
    active: false,

    /**
     * Called by BR.Sidebar when tab is activated
     */
    show() {
        this.active = true;
        this.options.requestUpdate(this);
    },

    /**
     * Called by BR.Sidebar when tab is deactivated
     */
    hide() {
        this.active = false;
    },

    /**
     * Everytime the track changes this method is called:
     *
     * - calculate statistics (way type, max speed, surface, smoothness)
     *   for the whole track
     * - renders statistics tables
     * - create event listeners which allow to hover/click a
     *   table row for highlighting matching track segments
     *
     * @param {Polyline} polyline
     * @param {Array} segments - route segments between waypoints
     */
    update(polyline, segments) {
        if (!this.active) {
            return;
        }

        if (segments.length === 0) {
            $('#track_statistics').html('');
            if (this.highlightedSegments) {
                this.map.removeLayer(this.highlightedSegments);
                this.highlightedSegments = null;
            }
            if (this.highlightedSegment) {
                this.map.removeLayer(this.highlightedSegment);
                this.highlightedSegment = null;
            }
            return;
        }

        this.trackPolyline = polyline;
        this.trackEdges = new BR.TrackEdges(segments);

        const analysis = this.calcStats(polyline, segments);

        this.render(analysis);

        $('.track-analysis-table tr').hover(L.bind(this.handleHover, this), L.bind(this.handleHoverOut, this));
        $('.track-analysis-table tbody').on('click', 'tr', L.bind(this.toggleSelected, this));
    },

    /**
     * This method does the heavy-lifting of statistics calculation.
     *
     * What happens here?
     *
     * - loop over all route segments
     * - for each segment loop over all contained points
     * - parse and analyze the `waytags` field between two consecutive points
     * - group the values for each examined category (highway, surface, smoothness) and sum up the distances
     *   - special handling for tracks: create an entry for each tracktype (and one if the tracktype is unknown)
     * - sort the result by distance descending
     *
     * @param polyline
     * @param segments
     * @returns {Object}
     */
    calcStats(polyline, segments) {
        const analysis = {
            highway: {},
            maxspeed: {},
            surface: {},
            smoothness: {},
        };

        this.totalRouteDistance = 0.0;

        for (let segmentIndex = 0; segments && segmentIndex < segments.length; segmentIndex++) {
            for (
                let messageIndex = 1;
                messageIndex < segments[segmentIndex].feature.properties.messages.length;
                messageIndex++
            ) {
                this.totalRouteDistance += parseFloat(
                    segments[segmentIndex].feature.properties.messages[messageIndex][3]
                );
                let wayTags = segments[segmentIndex].feature.properties.messages[messageIndex][9].split(' ');
                wayTags = this.normalizeWayTags(wayTags, 'cycling');
                for (let wayTagIndex = 0; wayTagIndex < wayTags.length; wayTagIndex++) {
                    let wayTagParts = wayTags[wayTagIndex].split('=');
                    let tagName = wayTagParts[0];
                    switch (tagName) {
                        case 'highway':
                            let highwayType = wayTagParts[1];
                            let trackType = '';
                            if (highwayType === 'track') {
                                trackType = this.getTrackType(wayTags);
                                highwayType = 'Track ' + trackType;
                            }
                            if (typeof analysis.highway[highwayType] === 'undefined') {
                                analysis.highway[highwayType] = {
                                    formatted_name: i18next.t(
                                        'sidebar.analysis.data.highway.' + highwayType,
                                        highwayType
                                    ),
                                    name: wayTagParts[1],
                                    subtype: trackType,
                                    distance: 0.0,
                                };
                            }
                            analysis.highway[highwayType].distance += parseFloat(
                                segments[segmentIndex].feature.properties.messages[messageIndex][3]
                            );
                            break;
                        case 'maxspeed':
                        case 'surface':
                        case 'smoothness':
                            if (typeof analysis[tagName][wayTagParts[1]] === 'undefined') {
                                let formattedName;

                                if (tagName.indexOf('maxspeed') === 0) {
                                    formattedName = i18next.t('sidebar.analysis.data.maxspeed', {
                                        maxspeed: wayTagParts[1],
                                    });
                                } else {
                                    formattedName = i18next.t([
                                        'sidebar.analysis.data.' + tagName + '.' + wayTagParts[1],
                                        wayTagParts[1],
                                    ]);
                                }

                                analysis[tagName][wayTagParts[1]] = {
                                    formatted_name: formattedName,
                                    name: wayTagParts[1],
                                    subtype: '',
                                    distance: 0.0,
                                };
                            }
                            analysis[tagName][wayTagParts[1]].distance += parseFloat(
                                segments[segmentIndex].feature.properties.messages[messageIndex][3]
                            );
                            break;
                    }
                }
            }
        }

        return this.sortAnalysisData(analysis);
    },

    /**
     * Normalize the tag name.
     *
     * Motivation: The `surface` and `smoothness` tags come in different variations,
     * e.g. `surface`, `cycleway:surface` etc. We're only interested
     * in the tag which matches the given routing type. All other variations
     * are dropped. If no specialized surface/smoothness tag is found, the default value
     * is returned, i.e. `smoothness` or `surface`.
     *
     * Also, maxspeed comes in different variations, e.g. `maxspeed`, `maxspeed:forward`,
     * `maxspeed:backward`. Depending on the existence of the `reversedirection` field
     * we can select the correct value.
     *
     * @param wayTags - tags + values for a way segment
     * @param routingType - currently only 'cycling' is supported, can be extended in the future (walking, driving, etc.)
     * @returns {*[]}
     */
    normalizeWayTags(wayTags, routingType) {
        let normalizedWayTags = {};
        let surfaceTags = {};
        let smoothnessTags = {};
        for (let wayTagIndex = 0; wayTagIndex < wayTags.length; wayTagIndex++) {
            let wayTagParts = wayTags[wayTagIndex].split('=');
            const tagName = wayTagParts[0];
            const tagValue = wayTagParts[1];

            if (tagName === 'surface') {
                surfaceTags.default = tagValue;
                continue;
            }
            if (tagName.indexOf(':surface') !== -1) {
                let tagNameParts = tagName.split(':');
                surfaceTags[tagNameParts[0]] = tagValue;
                continue;
            }

            if (tagName === 'smoothness') {
                smoothnessTags.default = tagValue;
                continue;
            }
            if (tagName.indexOf(':smoothness') !== -1) {
                let tagNameParts = tagName.split(':');
                smoothnessTags[tagNameParts[0]] = tagValue;
                continue;
            }

            if (tagName === 'maxspeed:forward' && !wayTags.includes('reversedirection=yes')) {
                normalizedWayTags['maxspeed'] = tagValue;
                continue;
            }
            if (tagName === 'maxspeed:backward' && wayTags.includes('reversedirection=yes')) {
                normalizedWayTags['maxspeed'] = tagValue;
                continue;
            }
            if (tagName === 'maxspeed') {
                normalizedWayTags[tagName] = tagValue;
                continue;
            }

            normalizedWayTags[tagName] = tagValue;
        }

        switch (routingType) {
            case 'cycling':
                if (typeof surfaceTags.cycleway === 'string') {
                    normalizedWayTags.surface = surfaceTags.cycleway;
                } else if (typeof surfaceTags.default === 'string') {
                    normalizedWayTags.surface = surfaceTags.default;
                }
                if (typeof smoothnessTags.cycleway === 'string') {
                    normalizedWayTags.smoothness = smoothnessTags.cycleway;
                } else if (typeof smoothnessTags.default === 'string') {
                    normalizedWayTags.smoothness = smoothnessTags.default;
                }
                break;
            default:
                if (typeof surfaceTags.default === 'string') {
                    normalizedWayTags.surface = surfaceTags.default;
                }
                if (typeof smoothnessTags.default === 'string') {
                    normalizedWayTags.smoothness = smoothnessTags.default;
                }
        }

        return this.wayTagsToArray(normalizedWayTags);
    },

    /**
     * Transform analysis data for each type into an array, sort it
     * by distance descending and convert it back to an object.
     *
     * @param {Object} analysis
     *
     * @returns {Object}
     */
    sortAnalysisData(analysis) {
        const analysisSortable = {};
        const result = {};

        for (const type in analysis) {
            if (!analysis.hasOwnProperty(type)) {
                continue;
            }

            result[type] = {};
            analysisSortable[type] = [];

            for (const name in analysis[type]) {
                if (!analysis[type].hasOwnProperty(name)) {
                    continue;
                }
                analysisSortable[type].push(analysis[type][name]);
            }

            if (type === 'maxspeed') {
                analysisSortable[type].sort(function (a, b) {
                    return parseInt(a.name) - parseInt(b.name);
                });
            } else {
                analysisSortable[type].sort(function (a, b) {
                    return b.distance - a.distance;
                });
            }

            for (let j = 0; j < analysisSortable[type].length; j++) {
                result[type][analysisSortable[type][j].formatted_name] = analysisSortable[type][j];
            }
        }

        return result;
    },

    /**
     * Extract the tracktype from a waytags string.
     * If no tracktype is found 'unknown' is returned.
     *
     * @param {string[]} wayTags
     * @returns {string}
     */
    getTrackType(wayTags) {
        for (let i = 0; i < wayTags.length; i++) {
            const wayTagParts = wayTags[i].split('=');
            if (wayTagParts[0] === 'tracktype') {
                return wayTagParts[1];
            }
        }

        return 'unknown';
    },

    /**
     * @param {Object} analysis
     */
    render(analysis) {
        const $content = $('#track_statistics');

        $content.html('');
        $content.append($(`<h4 class="track-analysis-heading">${i18next.t('sidebar.analysis.header.highway')}</h4>`));
        $content.append(this.renderTable('highway', analysis.highway));
        $content.append($(`<h4 class="track-analysis-heading">${i18next.t('sidebar.analysis.header.surface')}</h4>`));
        $content.append(this.renderTable('surface', analysis.surface));
        $content.append(
            $(`<h4 class="track-analysis-heading">${i18next.t('sidebar.analysis.header.smoothness')}</h4>`)
        );
        $content.append(this.renderTable('smoothness', analysis.smoothness));
        $content.append($(`<h4 class="track-analysis-heading">${i18next.t('sidebar.analysis.header.maxspeed')}</h4>`));
        $content.append(this.renderTable('maxspeed', analysis.maxspeed));
    },

    /**
     * Renders an analysis table.
     *
     * @param {string} type
     * @param {Array} data
     * @returns {jQuery}
     */
    renderTable(type, data) {
        let index;
        const $table = $(`<table data-type="${type}" class="mini stripe dataTable track-analysis-table"></table>`);
        const $thead = $('<thead></thead>');
        $thead.append(
            $('<tr>')
                .append(
                    `<th class="track-analysis-header-category">${i18next.t('sidebar.analysis.table.category')}</th>`
                )
                .append(
                    $(`<th class="track-analysis-header-distance">${i18next.t('sidebar.analysis.table.length')}</th>`)
                )
        );
        $table.append($thead);
        const $tbody = $('<tbody></tbody>');

        let totalDistance = 0.0;

        for (index in data) {
            if (!data.hasOwnProperty(index)) {
                continue;
            }
            const $row = $(`<tr data-name="${data[index].name}" \
                data-subtype="${data[index].subtype}" \
                data-distance="${data[index].distance}"></tr>`);
            $row.append(`<td class="track-analysis-title">${data[index].formatted_name}</td>`);
            $row.append(`<td class="track-analysis-distance">${this.formatDistance(data[index].distance)} km</td>`);
            $tbody.append($row);
            totalDistance += data[index].distance;
        }

        if (totalDistance < this.totalRouteDistance) {
            $tbody.append(
                $(`<tr data-name="internal-unknown" data-distance="${this.totalRouteDistance - totalDistance}"></tr>`)
                    .append($(`<td class="track-analysis-title">${i18next.t('sidebar.analysis.table.unknown')}</td>`))
                    .append(
                        $(
                            `<td class="track-analysis-distance">${this.formatDistance(
                                this.totalRouteDistance - totalDistance
                            )} km</td>`
                        )
                    )
            );
        }

        $table.append($tbody);

        $table.append(
            $('<tfoot></tfoot>')
                .append('<tr></tr>')
                .append($(`<td>${i18next.t('sidebar.analysis.table.total_known')}</td>`))
                .append(
                    $(
                        `<td class="track-analysis-distance track-analysis-distance-total">${this.formatDistance(
                            totalDistance
                        )} km</td>`
                    )
                )
        );

        return $table;
    },

    /**
     * Format a distance with two decimal places.
     *
     * @param {number} meters
     * @returns {string}
     */
    formatDistance(meters) {
        return (meters / 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    handleHover(event) {
        const $tableRow = $(event.currentTarget);
        const $table = $tableRow.parents('table').first();
        const dataType = $table.data('type');
        const dataName = $tableRow.data('name');
        const trackType = $tableRow.data('subtype');

        const polylinesForDataType = this.getPolylinesForDataType(dataType, dataName, trackType);

        this.highlightedSegments = L.layerGroup(polylinesForDataType).addTo(this.map);
    },

    handleHoverOut() {
        this.map.removeLayer(this.highlightedSegments);
    },

    toggleSelected(event) {
        const tableRow = event.currentTarget;
        const $table = $(tableRow).parents('table').first();
        const dataType = $table.data('type');
        const dataName = $(tableRow).data('name');
        const trackType = $(tableRow).data('subtype');

        if (tableRow.classList.toggle('selected')) {
            if (this.highlightedSegment) {
                this.map.removeLayer(this.highlightedSegment);
                this.selectedTableRow.classList.remove('selected');
            }
            this.highlightedSegment = L.layerGroup(this.getPolylinesForDataType(dataType, dataName, trackType)).addTo(
                this.map
            );
            this.selectedTableRow = tableRow;

            return;
        }

        this.map.removeLayer(this.highlightedSegment);
        this.selectedTableRow = null;
        this.highlightedSegment = null;
    },

    /**
     * Searching each track edge if it matches the requested
     * arguments (type, name, subtype if type == track). If the
     * track edge matches the search, create a Leaflet polyline
     * and add it to the result array.
     *
     * @param {string} dataType - `highway`, `surface`, `smoothness`
     * @param {string} dataName - `primary`, `track, `asphalt`, etc.
     * @param {string} trackType - the tracktype is passed here (e.g.
     * `grade3`), but only in the case that `dataName` is `track`
     *
     * @returns {Polyline[]}
     */
    getPolylinesForDataType(dataType, dataName, trackType) {
        const polylines = [];
        const trackLatLngs = this.trackPolyline.getLatLngs();

        for (let i = 0; i < this.trackEdges.edges.length; i++) {
            if (this.wayTagsMatchesData(trackLatLngs[this.trackEdges.edges[i]], dataType, dataName, trackType)) {
                const matchedEdgeIndexStart = i > 0 ? this.trackEdges.edges[i - 1] : 0;
                const matchedEdgeIndexEnd = this.trackEdges.edges[i] + 1;
                polylines.push(
                    L.polyline(
                        trackLatLngs.slice(matchedEdgeIndexStart, matchedEdgeIndexEnd),
                        this.options.overlayStyle
                    )
                );
            }
        }

        return polylines;
    },

    /**
     * Examine the way tags string if it matches the data arguments.
     * Special handling for implicit defined dataName 'internal-unknown'
     * which matches if a tag-pair is missing. Special handling for
     * tracktypes again.
     *
     * @param {string} wayTags - The way tags as provided by brouter, e.g.
     * `highway=secondary surface=asphalt smoothness=good`
     * @param {string} dataType - `highway`, `surface`, `smoothness`
     * @param {string} dataName - `primary`, `track, `asphalt`, etc.
     * @param {string} trackType - the tracktype is passed here (e.g.
     * `grade3`), but only in the case that `dataName` is `track`
     *
     * @returns {boolean}
     */
    wayTagsMatchesData(wayTags, dataType, dataName, trackType) {
        const parsed = this.wayTagsToObject(wayTags);

        switch (dataType) {
            case 'highway':
                if (dataName === 'track') {
                    if (trackType === 'unknown' && parsed.highway === 'track' && !parsed.tracktype) {
                        return true;
                    }

                    return typeof parsed.tracktype === 'string' && parsed.tracktype === trackType;
                } else if (dataName === 'internal-unknown' && typeof parsed.highway !== 'string') {
                    return true;
                }

                return typeof parsed.highway === 'string' && parsed.highway === dataName;
            case 'surface':
                return this.singleWayTagMatchesData('surface', parsed, dataName);
            case 'smoothness':
                return this.singleWayTagMatchesData('smoothness', parsed, dataName);
            case 'maxspeed':
                return this.singleWayTagMatchesData('maxspeed', parsed, dataName);
        }

        return false;
    },

    singleWayTagMatchesData(category, parsedData, lookupValue) {
        if (typeof lookupValue === 'number') {
            lookupValue = lookupValue.toString();
        }

        let foundValue = null;

        // We need to handle `maxspeed:forward` and `maxspeed:backward` separately
        // from all other tags, because we need to consider the `reversedirection`
        // tag.
        // Test URL: http://localhost:3000/#map=15/52.2292/13.6204/standard&lonlats=13.61948,52.231611;13.611327,52.227431
        if (
            category === 'maxspeed' &&
            parsedData.hasOwnProperty('maxspeed:forward') &&
            !parsedData.hasOwnProperty('reversedirection')
        ) {
            foundValue = parsedData['maxspeed:forward'];
        }
        if (
            category === 'maxspeed' &&
            parsedData.hasOwnProperty('maxspeed:backward') &&
            parsedData.hasOwnProperty('reversedirection') &&
            parsedData.reversedirection === 'yes'
        ) {
            foundValue = parsedData['maxspeed:backward'];
        }

        // if the special handling for `maxspeed` didn't find a result,
        // check wayTags for matching property:
        if (foundValue === null && parsedData.hasOwnProperty(category)) {
            foundValue = parsedData[category];
        }

        if (lookupValue === 'internal-unknown' && foundValue === null) {
            return true;
        }

        return foundValue === lookupValue;
    },

    /**
     * Transform a way tags string into an object, for example:
     *
     * 'highway=primary surface=asphalt' => { highway: 'primary', surface: 'asphalt' }
     *
     * @param wayTags - The way tags as provided by brouter, e.g.
     * `highway=secondary surface=asphalt smoothness=good`
     *
     * @returns {object}
     */
    wayTagsToObject(wayTags) {
        let result = {};
        const wayTagPairs = wayTags.feature.wayTags.split(' ');

        for (let j = 0; j < wayTagPairs.length; j++) {
            const wayTagParts = wayTagPairs[j].split('=');
            result[wayTagParts[0]] = wayTagParts[1];
        }

        return result;
    },

    /**
     * Transform a way tags object into an array representation, for example:
     *
     * { 'highway' : 'path', 'surface' : 'sand' } => ['highway=path', 'surface=sand']
     *
     * @param wayTags - The way tags in object representation
     *
     * @returns {object}
     */
    wayTagsToArray(wayTags) {
        let wayTagsArray = [];
        for (let wayTagKey in wayTags) {
            wayTagsArray.push(wayTagKey + '=' + wayTags[wayTagKey]);
        }

        return wayTagsArray;
    },
});
