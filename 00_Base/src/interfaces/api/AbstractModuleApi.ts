// Copyright (c) 2023 S44, LLC
// Copyright Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache 2.0

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import 'reflect-metadata';
import { ILogObj, Logger } from "tslog";
import { HttpMethod, IDataEndpointDefinition, IMessageEndpointDefinition, METADATA_DATA_ENDPOINTS, METADATA_MESSAGE_ENDPOINTS } from ".";
import { OcppRequest, OcppResponse, SystemConfig } from "../..";
import { Namespace } from "../../ocpp/persistence";
import { CallAction } from "../../ocpp/rpc/message";
import { IMessageConfirmation } from "../messages";
import { IModule } from "../modules";
import { IMessageQuerystring, IMessageQuerystringSchema } from "./MessageQuerystring";
import { IModuleApi } from "./ModuleApi";

/**
 * Abstract module api class implementation.
 */
export abstract class AbstractModuleApi<T extends IModule> implements IModuleApi {

    protected readonly _server: FastifyInstance;
    protected readonly _module: T;
    protected readonly _logger: Logger<ILogObj>;

    constructor(module: T, server: FastifyInstance, logger?: Logger<ILogObj>) {
        this._module = module;
        this._server = server;

        this._logger = logger ? logger.getSubLogger({ name: this.constructor.name }) : new Logger<ILogObj>({ name: this.constructor.name });
        this._init(this._module);
    }

    /**
     * Initializes the API for the given module.
     *
     * @param {T} module - The module to initialize the API for.
     */
    protected _init(module: T): void {
        (Reflect.getMetadata(METADATA_MESSAGE_ENDPOINTS, this.constructor) as Array<IMessageEndpointDefinition>)?.forEach((expose) => {
            this._addMessageRoute.call(this, expose.action, expose.method, expose.bodySchema);
        });
        (Reflect.getMetadata(METADATA_DATA_ENDPOINTS, this.constructor) as Array<IDataEndpointDefinition>)?.forEach((expose) => {
            this._addDataRoute.call(this, expose.namespace, expose.method, expose.httpMethod, expose.querySchema, expose.bodySchema);
        });

        // Add API routes for getting and setting SystemConfig
        this._addDataRoute.call(this, Namespace.SystemConfig, () => module.config, HttpMethod.Get);
        this._addDataRoute.call(this, Namespace.SystemConfig, (request: FastifyRequest<{ Body: SystemConfig }>) => module.config = request.body, HttpMethod.Put);
    }

    /**
     * Add a message route to the server.
     *
     * @param {CallAction} action - The action to be called.
     * @param {Function} method - The method to be executed.
     * @param {object} schema - The schema for the route.
     * @return {void}
     */
    // eslint-disable-next-line @typescript-eslint/ban-types
    protected _addMessageRoute(action: CallAction, method: Function, bodySchema: object): void {
        this._logger.debug(`Adding message route for ${action}`, this._toMessagePath(action));

        /**
         * Executes the handler function for the given request.
         *
         * @param {FastifyRequest<{ Body: OcppRequest | OcppResponse, Querystring: IMessageQuerystring }>} request - The request object containing the body and querystring.
         * @return {Promise<IMessageConfirmation>} The promise that resolves to the message confirmation.
         */
        const _handler = async (request: FastifyRequest<{ Body: OcppRequest | OcppResponse, Querystring: IMessageQuerystring }>): Promise<IMessageConfirmation> => {
            return method.call(this, request.query.identifier, request.query.tenantId, request.body, request.query.callbackUrl);
        };

        const _opts = {
            schema: {
                body: bodySchema,
                querystring: IMessageQuerystringSchema
            } as const
        };

        if (this._module.config.util.swagger?.exposeMessage) {
            this._server.register(async (fastifyInstance) => {
                fastifyInstance.post(this._toMessagePath(action), _opts, _handler);
            });
        } else {
            this._server.post(this._toMessagePath(action), _opts, _handler);
        }
    }

    /**
     * Add a message route to the server.
     *
     * @param {Namespace} namespace - The entity type.
     * @param {Function} method - The method to be executed.
     * @param {object} schema - The schema for the entity.
     * @return {void}
     */
    // eslint-disable-next-line @typescript-eslint/ban-types
    protected _addDataRoute(namespace: Namespace, method: Function, httpMethod: HttpMethod, querySchema?: object, bodySchema?: object): void {
        this._logger.debug(`Adding data route for ${namespace}`, this._toDataPath(namespace), httpMethod);
        const schema: Record<string, object> = {};
        if (querySchema) {
            schema["querystring"] = querySchema;
        }
        if (bodySchema) {
            schema["body"] = bodySchema;
        }

        /**
         * Handles the request and returns a Promise resolving to an object.
         *
         * @param {FastifyRequest<{ Body: object, Querystring: object }>} request - the request object
         * @param {FastifyReply} reply - the reply object
         * @return {Promise<any>} - a Promise resolving to an object
         */
        const _handler = async (request: FastifyRequest<{ Body: object, Querystring: object }>, reply: FastifyReply): Promise<unknown> => {
            return (method.call(this, request, reply) as Promise<undefined | string | object>).catch(err => {
                // TODO: figure out better error codes & messages
                this._logger.error("Error in handling data route", err);
                reply.status(500).send(err);
            });
        };

        const _opts = {
            method: httpMethod,
            url: this._toDataPath(namespace),
            schema: schema,
            handler: _handler
        };

        if (this._module.config.util.swagger?.exposeData) {
            this._server.register(async (fastifyInstance) => {
                fastifyInstance.route<{ Body: object, Querystring: object }>(_opts);
            });
        } else {
            this._server.route<{ Body: object, Querystring: object }>(_opts);
        }
    }

    /**
     * Convert a {@link CallAction} to a normed lowercase URL path.
     * 
     * @param {CallAction} input - The {@link CallAction} to convert to a URL path.
     * @returns {string} - String representation of URL path.
     */
    protected _toMessagePath(input: CallAction, prefix?: string): string {
        const endpointPrefix = prefix || "";
        return `/ocpp${!endpointPrefix.startsWith("/") ? "/" : ""}${endpointPrefix}${!endpointPrefix.endsWith("/") ? "/" : ""}${input.charAt(0).toLowerCase() + input.slice(1)}`;
    }

    /**
     * Convert a {@link Namespace} to a normed lowercase URL path.
     * 
     * @param {Namespace} input - The {@link Namespace} to convert to a URL path.
     * @returns {string} - String representation of URL path.
     */
    protected _toDataPath(input: Namespace, prefix?: string): string {
        const endpointPrefix = prefix || "";
        return `/data${!endpointPrefix.startsWith("/") ? "/" : ""}${endpointPrefix}${!endpointPrefix.endsWith("/") ? "/" : ""}${input.charAt(0).toLowerCase() + input.slice(1)}`;
    }
}