'use strict'

const promisify           = require('es6-promisify').promisify
const Boom                = require('boom')
const Joi                 = require('joi')
const Hoek                = require('hoek')
const RbacCore            = require('rbac-core')
const DataRetrievalRouter = RbacCore.DataRetrievalRouter

const CONFIG_NONE = 'none'

const internals = {}
const schemas   = {}
const defaults  = {}

schemas.policyRetriever                      = Joi.func()
schemas.policy                               = Joi.object()
schemas.DataRetrievalRouter_register_handles = Joi.alternatives().try(
    Joi.string().min(1),
    Joi.array().items(Joi.string().min(1))
)

/**
 * If the configuration is a function, then this function should retrieve the access policy (e.g.: from a database).
 * Otherwise, it is assumed that the configuration is the access policy itself.
 *
 * The callback signature is function (err, policy) {}
 **/
internals.retrievePolicy = (config, request, h) => {
    return new Promise((resolve, reject) => {
        return config instanceof Function ? resolve(config(request, h)) : resolve(config)
    })
}


/**
 * Hapi register function
 **/
schemas.register_options = Joi.object({
    onError: Joi.func().optional(),
    responseCode: Joi.object({
        onDeny: Joi.number().optional(),
        onUndetermined: Joi.number().optional()
    }).optional(),
    policy: Joi.alternatives().try(
        schemas.policyRetriever,
        schemas.policy
    ).optional(),
    dataRetrievers: Joi.array().items(
        Joi.object({
            handles: schemas.DataRetrievalRouter_register_handles.required(),
            handler: Joi.func().required()
        })
    ).optional()
})

defaults.options = {
    onError: (request, h, err) => {
        throw Boom.wrap(err, 401)
    },
    responseCode: {
        onDeny: 401,
        onUndetermined: 401
    },
    dataRetrievers: []
}

const register = (server, options) => {

    Joi.assert(options, schemas.register_options)

    options = Hoek.applyToDefaults(defaults.options, options)

    // Register default data retrievers
    const dataRetriever = new DataRetrievalRouter()
    dataRetriever.register('credentials', require('./dataRetrievers/credentials'))
    dataRetriever.register('connection', require('./dataRetrievers/connection'))
    dataRetriever.register('query', require('./dataRetrievers/query-params'))
    dataRetriever.register(['param', 'params'], require('./dataRetrievers/url-params'))
    dataRetriever.register('request', require('./dataRetrievers/request'))

    // Load user defined data retrievers
    options.dataRetrievers.forEach((dataRetrieverItem) => {
        dataRetriever.register(dataRetrieverItem.handles, dataRetrieverItem.handler)
    })

    server.ext('onPostAuth', (request, h) => {
        const config = request.route.settings.plugins.rbac || options.policy

        if (config && config !== CONFIG_NONE) {
            return internals
                .retrievePolicy(config, request, h)
                .then((policy) => {
                    if (!policy || policy === CONFIG_NONE) {
                        return h.continue
                    }

                    // Add context to data retriever's child
                    const wrappedDataRetriever = dataRetriever.createChild(request)
                    const evaluatePolicy = promisify(RbacCore.evaluatePolicy)

                    return evaluatePolicy(policy, wrappedDataRetriever)
                        .then((result) => {
                            if (result === RbacCore.DENY) {
                                throw Boom.create(options.responseCode.onDeny, 'No permissions to access this resource')
                            }

                            if (result === RbacCore.UNDETERMINED) {
                                throw Boom.create(options.responseCode.onUndetermined, 'Could not evaluate access rights to resource')
                            }

                            return h.continue
                        })
                })
        }

        return h.continue
    })
}

module.exports = {
    register: register,
    name: 'RbacPlugin',
    version: '2'
}
