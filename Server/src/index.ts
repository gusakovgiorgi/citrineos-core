// Copyright (c) 2023 S44, LLC
// Copyright Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache 2.0

import {
  type AbstractModule,
  type AbstractModuleApi,
  EventGroup,
  eventGroupFromString,
  type ICache,
  type ICentralSystem,
  type IMessageHandler,
  type IMessageSender,
  type IModule,
  type IModuleApi,
  type SystemConfig
} from '@citrineos/base'
import {MonitoringModule, MonitoringModuleApi} from '@citrineos/monitoring'
import {
  CentralSystemImpl,
  initSwagger,
  MemoryCache,
  RabbitMqReceiver,
  RabbitMqSender,
  RedisCache
} from '@citrineos/util'
import {type JsonSchemaToTsProvider} from '@fastify/type-provider-json-schema-to-ts'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import fastify, {type FastifyInstance} from 'fastify'
import {type ILogObj, Logger} from 'tslog'
import {systemConfig} from './config'
import {ConfigurationModule, ConfigurationModuleApi} from '@citrineos/configuration'
import {TransactionsModule, TransactionsModuleApi} from '@citrineos/transactions'
import {CertificatesModule, CertificatesModuleApi} from '@citrineos/certificates'
import {EVDriverModule, EVDriverModuleApi} from '@citrineos/evdriver'
import {ReportingModule, ReportingModuleApi} from '@citrineos/reporting'
import {SmartChargingModule, SmartChargingModuleApi} from '@citrineos/smartcharging'
import {sequelize} from '@citrineos/data'
import {FastifyRouteSchemaDef, FastifySchemaCompiler, FastifyValidationResult} from "fastify/types/schema";

interface ModuleConfig {
  ModuleClass: new (...args: any[]) => AbstractModule
  ModuleApiClass: new (...args: any[]) => AbstractModuleApi<any>
  configModule: any // todo type?
}

export class Server {
  /**
   * Fields
   */
  private _config: SystemConfig
  private _centralSystem?: ICentralSystem
  private _logger?: Logger<ILogObj>
  private _server: FastifyInstance
  private _cache?: ICache
  private _ajv?: Ajv
  private modules: Array<IModule> = [];
  private apis: Array<IModuleApi> = [];
  private host?: string;
  private port?: number;
  private eventGroup?: EventGroup;


  /**
   * Constructor for the class.
   *
   * @param {EventGroup} appName - app type
   * @param {SystemConfig} config - config
   * @param {FastifyInstance} server - optional Fastify server instance
   * @param {Ajv} ajv - optional Ajv JSON schema validator instance
   */
  // todo rename event group to type
  constructor(appName: string, config: SystemConfig, server?: FastifyInstance, ajv?: Ajv, cache?: ICache) {
    // Set system config
    // TODO: Create and export config schemas for each util module, such as amqp, redis, kafka, etc, to avoid passing them possibly invalid configuration
    if (!config.util.messageBroker.amqp) {
      throw new Error('This server implementation requires amqp configuration for rabbitMQ.')
    }
    this._config = config

    // Create server instance
    this._server = server || fastify().withTypeProvider<JsonSchemaToTsProvider>()

    // Add health check
    this.initHealthCheck();

    // Create Ajv JSON schema validator instance
    this.initAjv(ajv);

    // Initialize parent logger
    this.initLogger();

    // Force sync database
    this.forceDbSync();

    // Set cache implementation
    this.initCache(cache);

    // Initialize Swagger if enabled
    this.initSwagger();

    // Register AJV for schema validation
    this.registerAjv();

    // Initialize module & API
    // Always initialize API after SwaggerUI
    this.initSystem(appName);

    process.on('SIGINT', this.shutdown.bind(this))
    process.on('SIGTERM', this.shutdown.bind(this))
    process.on('SIGQUIT', this.shutdown.bind(this))
  }

  private initHealthCheck() {
    this._server.get('/health', async () => {
      return {status: 'healthy'}
    })
  }

  private initAjv(ajv?: Ajv) {
    this._ajv = ajv || new Ajv({
      removeAdditional: 'all',
      useDefaults: true,
      coerceTypes: 'array',
      strict: false
    })
    addFormats(this._ajv, {
      mode: 'fast',
      formats: ['date-time']
    })
  }

  private initLogger() {
    this._logger = new Logger<ILogObj>({
      name: 'CitrineOS Logger',
      minLevel: systemConfig.server.logLevel,
      hideLogPositionForProduction: systemConfig.env === 'production'
    })
  }

  private forceDbSync() {
    sequelize.DefaultSequelizeInstance.getInstance(this._config, this._logger, true)
  }

  private initCache(cache?: ICache) {
    this._cache = cache || (this._config.util.cache.redis
      ? new RedisCache({
        socket: {
          host: this._config.util.cache.redis.host,
          port: this._config.util.cache.redis.port
        }
      })
      : new MemoryCache())
  }

  private initSwagger() {
    if (this._config.util.swagger) {
      initSwagger(this._config, this._server)
    }
  }

  private registerAjv() {
    // todo type schema instead of any
    const fastifySchemaCompiler: FastifySchemaCompiler<any> = (routeSchema: FastifyRouteSchemaDef<any>) => {
      return this._ajv?.compile(routeSchema.schema) as FastifyValidationResult;
    };
    this._server.setValidatorCompiler(fastifySchemaCompiler);
  }

  private initCentralSystem() {
    this._centralSystem = new CentralSystemImpl(this._config, this._cache as ICache, undefined, undefined, this._logger, this._ajv)
    this.host = this._config.server.host
    this.port = this._config.server.port
  }

  private initAllModules() {
    [
      this.getModuleConfig(EventGroup.Certificates),
      this.getModuleConfig(EventGroup.Configuration),
      this.getModuleConfig(EventGroup.EVDriver),
      this.getModuleConfig(EventGroup.Monitoring),
      this.getModuleConfig(EventGroup.Reporting),
      this.getModuleConfig(EventGroup.SmartCharging),
      this.getModuleConfig(EventGroup.Transactions)
    ].forEach(moduleConfig => this.initModule(moduleConfig));
  }

  private initModule(moduleConfig: ModuleConfig) {
    if (moduleConfig.configModule !== null) {
      const module = new moduleConfig.ModuleClass(
        this._config,
        this._cache,
        this._createSender(),
        this._createHandler(),
        this._logger
      );
      this.modules.push(module);
      this.apis.push(
        new moduleConfig.ModuleApiClass(
          module,
          this._server,
          this._logger
        )
      );
      // TODO: take actions to make sure module has correct subscriptions and log proof
      this._logger?.info(`${moduleConfig.ModuleClass.name} module started...`)
      if (this.eventGroup !== EventGroup.All) {
        this.host = moduleConfig.configModule.host as string
        this.port = moduleConfig.configModule.port as number
      }
    } else {
      throw new Error(`No config for ${this.eventGroup} module`)
    }
  }

  private getModuleConfig(appName: EventGroup): ModuleConfig {
    switch (appName) {
      case EventGroup.Certificates:
        return {
          ModuleClass: CertificatesModule,
          ModuleApiClass: CertificatesModuleApi,
          configModule: this._config.modules.certificates
        }
      case EventGroup.Configuration:
        return {
          ModuleClass: ConfigurationModule,
          ModuleApiClass: ConfigurationModuleApi,
          configModule: this._config.modules.configuration
        }
      case EventGroup.EVDriver:
        return {
          ModuleClass: EVDriverModule,
          ModuleApiClass: EVDriverModuleApi,
          configModule: this._config.modules.evdriver
        }
      case EventGroup.Monitoring:
        return {
          ModuleClass: MonitoringModule,
          ModuleApiClass: MonitoringModuleApi,
          configModule: this._config.modules.monitoring
        }
      case EventGroup.Reporting:
        return {
          ModuleClass: ReportingModule,
          ModuleApiClass: ReportingModuleApi,
          configModule: this._config.modules.reporting
        }
      case EventGroup.SmartCharging:
        return {
          ModuleClass: SmartChargingModule,
          ModuleApiClass: SmartChargingModuleApi,
          configModule: this._config.modules.smartcharging
        }
      case EventGroup.Transactions:
        return {
          ModuleClass: TransactionsModule,
          ModuleApiClass: TransactionsModuleApi,
          configModule: this._config.modules.transactions
        }
      default:
        throw new Error('Unhandled module type: ' + appName)
    }
  }

  private initSystem(appName: string) {
    this.eventGroup = eventGroupFromString(appName);
    if (this.eventGroup === EventGroup.All) {
      this.initCentralSystem();
      this.initAllModules();
    } else if (this.eventGroup === EventGroup.General) {
      this.initCentralSystem();
    } else {
      const moduleConfig: ModuleConfig = this.getModuleConfig(this.eventGroup);
      this.initModule(moduleConfig);
    }
  }

  protected _createSender(): IMessageSender {
    return new RabbitMqSender(this._config, this._logger)
  }

  protected _createHandler(): IMessageHandler {
    return new RabbitMqReceiver(this._config, this._logger)
  }

  shutdown() {
    // todo shut down depending on setup
    // Shut down all modules and central system
    this.modules.forEach(module => {
      module.shutdown();
    });
    this._centralSystem?.shutdown();

    // Shutdown server
    this._server.close().then(); // todo async?

    setTimeout(() => {
      console.log('Exiting...')
      process.exit(1)
    }, 2000)
  }

  async run(): Promise<void> {
    try {
      await this._server.listen({
        host: this.host,
        port: this.port
      }).then(address => {
        this._logger?.info(`Server listening at ${address}`)
      }).catch(error => {
        this._logger?.error(error)
        process.exit(1)
      })
      // TODO Push config to microservices
    } catch (error) {
      await Promise.reject(error)
    }
  }
}