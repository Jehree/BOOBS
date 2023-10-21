/* eslint-disable @typescript-eslint/brace-style */
import { DependencyContainer } from "tsyringe";
import { IPostDBLoadMod } from "@spt-aki/models/external/IPostDBLoadMod";
import { DatabaseServer } from "@spt-aki/servers/DatabaseServer";
import { ITemplateItem } from "@spt-aki/models/eft/common/tables/ITemplateItem";
import { ILogger } from "@spt-aki/models/spt/utils/ILogger";
import { LogTextColor } from "@spt-aki/models/spt/logging/LogTextColor";
import { IDatabaseTables } from "@spt-aki/models/spt/server/IDatabaseTables";
import { JsonUtil } from "@spt-aki/utils/JsonUtil";

import * as config from "../config/config.json";
import * as ammoBoxesJson from "../config/box info/ammoboxes.json";
import * as ammoTiersJson from "../config/configs/ammotiers.json";
import * as ammoTiersRealismJson from "../config/realism configs/ammotiers_realism.json";
import * as ammoWeightsJson from "../config/configs/weights.json";
import * as ammoWeightsRealismJson from "../config/realism configs/weights_realism.json";

type AmmoWeights = typeof ammoWeightsRealismJson.CATEGORIES | typeof ammoWeightsJson.CATEGORIES
type AmmoTiers = typeof ammoTiersRealismJson.CALIBERS | typeof ammoTiersJson.CALIBERS
type AmmoBoxes = typeof ammoBoxesJson.BOXES

class Mod implements IPostDBLoadMod
{
    public postDBLoad(container: DependencyContainer): void {

        const databaseServer = container.resolve<DatabaseServer>("DatabaseServer");
        const lg = container.resolve<ILogger>("WinstonLogger")
        const jsonUtil = container.resolve<JsonUtil>("JsonUtil")
        const dbTables = databaseServer.getTables();
        const dbLocations = dbTables.locations

        lg.log("[BOOBS]: Pushing ammo boxes to database...", LogTextColor.MAGENTA)
        this.pushAmmoBoxesToDB(dbTables, jsonUtil, lg)
        lg.log("[BOOBS]: Done!", LogTextColor.GREEN)


        if (config.spt_realism_ammo_compat){
            lg.log("[BOOBS]: Realism compatibility enabled, adjusting ammo tiers to SPT Realism's ammo stats", LogTextColor.GREEN)
        }

        lg.log("[BOOBS]: Editing loose loot spawn points...", LogTextColor.MAGENTA)
        for (const mapKey in dbLocations){

            const thisMapLooseLoot =  dbTables.locations[mapKey]?.looseLoot?.spawnpoints
            if (thisMapLooseLoot === undefined) continue

            const itemWeights = this.getItemWeights()

            this.setMapAmmoSpawns(thisMapLooseLoot, itemWeights, dbTables, lg)
        }
        lg.log("[BOOBS]: Done!", LogTextColor.GREEN)
    }

    pushAmmoBoxesToDB(dbTables, jsonUtil, lg){

        const dbHandbook = dbTables.templates.handbook;
        const locales = Object.values(dbTables.locales.global) as Record<string, string>[];

        const configAmmoBoxes = ammoBoxesJson.BOXES
        const configAmmoTiers = ammoTiersJson.CALIBERS
        for (const caliber in configAmmoBoxes){

            const thisCaliber = configAmmoBoxes[caliber]

            if (configAmmoTiers[caliber].type === "GRENADES_UGL_FLARES") continue

            for (const boxId in thisCaliber){

                const thisConfigBox = thisCaliber[boxId]
                if (thisConfigBox.disabled) continue
                if (thisConfigBox.box_type === undefined){
                    lg.log("CHECK ammoboxes.json FILE FOR MISSING OR MISPELLED box_type", "red")
                    continue
                }

                const ammoBox = this.createAmmoBox(jsonUtil, dbTables, thisConfigBox, boxId)           
                dbTables.templates.items[boxId] = ammoBox

                dbHandbook.Items.push(
                    {
                        "Id": boxId,
                        "ParentId": "5b47574386f77428ca22b33c",
                        "Price": 0
                    }
                );

                for (const locale of locales) {
                    locale[`${boxId} Name`] = `Carboard box holding ${locale[`${thisConfigBox.roundInBox_id} Name`]} rounds`
                    locale[`${boxId} ShortName`] = locale[`${thisConfigBox.roundInBox_id} ShortName`]
                    locale[`${boxId} Description`] = `Carboard box holding ${locale[`${thisConfigBox.roundInBox_id} Name`]} rounds`
                }
            }
        }
    }

    createAmmoBox(jsonUtil, dbTables, configBox, boxId){

        const roundInBoxId = configBox.roundInBox_id
        const boxType = configBox.box_type ?? "DEFAULT"

        const newBox = jsonUtil.clone(dbTables.templates.items["5737330a2459776af32363a1"])
        newBox._id = boxId

        newBox._name = boxId
        newBox._props.Name = boxId
        newBox._props.ShortName = boxId
        newBox._props.Description = boxId

        newBox._props.Width = config.box_types[boxType].sizeH ?? 1
        newBox._props.Height = config.box_types[boxType].sizeV ?? 1
        
        newBox._props.StackSlots[0]._parent = boxId
        newBox._props.StackSlots[0]._props.filters[0].Filter = [roundInBoxId]
        newBox._props.StackSlots[0]._max_count = configBox.round_count

        const bundlePath = config.box_types[boxType].bundle_path
        newBox._props.Prefab.path = bundlePath

        return newBox
    }

    getItemWeights(){

        let ammoWeights:AmmoWeights = ammoWeightsJson.CATEGORIES
        if (config.spt_realism_ammo_compat){
            ammoWeights = ammoWeightsRealismJson.CATEGORIES
        }

        let ammoTiers:AmmoTiers = ammoTiersJson.CALIBERS
        if (config.spt_realism_ammo_compat){
            ammoTiers = ammoTiersRealismJson.CALIBERS
        }

        const itemWeights = {}

        for (const caliber in ammoTiers){

            const thisCaliberTiers = ammoTiers[caliber]
            const thisWeightType:string = thisCaliberTiers.type ?? "GENERAL"
            const thisCategoryWeights:{string: number} = this.copyObject(ammoWeights[thisWeightType])

            //set weight to 0 if there are no ammos in a tier
            for (const tier in thisCategoryWeights){

                if (thisCaliberTiers[tier]?.length === 0){

                    thisCategoryWeights[tier] = 0
                }
            }
            
            //get sum of multiplier numbers from this tier
            const summedMultipliers = this.getSumOfWeights(thisCategoryWeights, 4)

            //all caliberss start with a weight of 1200 that gets multiplied by their respective cal multiplier
            const totalAllottedPointsMultipliers = ammoWeights.CALIBERS
            const totalAllottedWeight = 100000 * totalAllottedPointsMultipliers[caliber]
            
            /* formuala below (thanks chatGPT!)
            share_A = (m_A / total_multiplier) * totalPointsForCategory
            share_B = (m_B / total_multiplier) * totalPointsForCategory
            share_C = (m_C / total_multiplier) * totalPointsForCategory
            share_D = (m_D / total_multiplier) * totalPointsForCategory
            */


            for (const tier in thisCaliberTiers){

                const skipTheseParams = ["type", "box_type"]
                if (skipTheseParams.includes(tier)) continue

                const thisTierMultiplier = thisCategoryWeights[tier]

                const thisTierAlottedWeight = (thisTierMultiplier / summedMultipliers) * totalAllottedWeight

                //loop thru this tier's ammos and divide the alloted weight we calc'd among them
                //then add that to the itemWeights object
                const thisTierAmmos:Array<string> = thisCaliberTiers[tier]

                for (const i in thisTierAmmos){
                    const thisRoundName = thisTierAmmos[i]
                    let itemWeight = Math.round(thisTierAlottedWeight / thisTierAmmos.length)
                    if (itemWeight <= 0){itemWeight = 1}
                    itemWeights[thisRoundName] = itemWeight
                }
            }
        }
        return itemWeights
    }

    copyObject(input:any):any{
        return JSON.parse(JSON.stringify(input))
    }

    getSumOfWeights(object:any, decimalPoints:number):number{
        const values = Object.values(object)
        const summedValues = +(values.reduce((init:number, iter:number) => init + iter, 0))
        const fixedSummedValues = +summedValues.toFixed(decimalPoints)

        

        return fixedSummedValues
    }

    setMapAmmoSpawns(mapLootSpawnpoints, itemWeights, dbTables: IDatabaseTables, lg):void{

        /*
        for (const i in itemWeights){
            if (itemWeights[i] <= 10){
                console.log(i)
            }
        }
        console.log("END")
        */
        
        

        const ammoBoxes:AmmoBoxes = ammoBoxesJson.BOXES

        let ammoTiers:AmmoTiers = ammoTiersJson.CALIBERS
        if (config.spt_realism_ammo_compat){
            ammoTiers = ammoTiersRealismJson.CALIBERS
        }

        const dbItems = dbTables.templates.items
        
        spawnPointLoop:
        for (const loot in mapLootSpawnpoints){
            const thisSpawnPoint = mapLootSpawnpoints[loot]
            const thisSpawnPointTemplate = thisSpawnPoint.template
            thisSpawnPoint.probability *= ammoWeightsJson.GLOBAL_AMMO_SPAWN_CHANCE_MULTI
            let thisPointSpawnsAmmo = false

            //first pass to check for blacklisted item types
            for (const item in thisSpawnPointTemplate?.Items){
                const blacklistedItemTypes = config.spawnpoint_item_type_blacklist
                const thisItemParentId = dbItems[thisSpawnPointTemplate.Items[item]?._tpl]?._parent

                if (blacklistedItemTypes.includes(thisItemParentId)) continue spawnPointLoop

                if (thisItemParentId === "543be5cb4bdc2deb348b4568"){
                    thisPointSpawnsAmmo = true
                }
            }

            if (!thisPointSpawnsAmmo) continue spawnPointLoop

            //-----------------------------------------------------------------------------
            //at this point, we know that we have a spawnpoint that can spawn ammo boxes
            //and that does not include any of the blacklisted item types
            //-----------------------------------------------------------------------------

            thisSpawnPointTemplate.Items = []
            thisSpawnPoint.itemDistribution = []

            for (const caliber in ammoBoxes){

                const thisCaliber = ammoBoxes[caliber]

                let isGrenadeUGLOrFlare = false
                let isAmmoBox = false

                if (ammoTiers[caliber]?.type === "GRENADES_UGL_FLARES"){
                    isGrenadeUGLOrFlare = true
                } else {
                    isAmmoBox = true
                }

                if (isGrenadeUGLOrFlare){
                    for (const nadeName in thisCaliber){


                        const thisNadeConfig = thisCaliber[nadeName]
                        if (thisNadeConfig.disabled) continue

                        const thisNadeWeightValue = itemWeights[nadeName]

                        if (thisNadeWeightValue === undefined){
                            lg.log("CHECK WEIGHTS JSONS FOR MISPELLED AMMO!!", "red")
                            continue
                        }

                        const nadeTpl = thisCaliber[nadeName]
                        const nadeInstanceId = nadeName + "_SpawnPoint_Instance_Id"
                        
                        thisSpawnPointTemplate.Items.push(
                            {
                                _id: nadeInstanceId,
                                _tpl: nadeTpl
                            }
                        )
                        thisSpawnPoint.itemDistribution.push(
                            {
                                composedKey: {
                                    key: nadeInstanceId
                                },
                                relativeProbability: thisNadeWeightValue
                            }
                        )
                    }
                }

                if (isAmmoBox) {
                    for (const boxTpl in thisCaliber){

                        const thisBoxConfig = thisCaliber[boxTpl]
                        if (thisBoxConfig.disabled) continue

                        const thisBoxWeightValue = itemWeights[thisBoxConfig.roundInBox_name]

                        if (thisBoxWeightValue === undefined){
                            lg.log("CHECK WEIGHTS JSONS FOR MISPELLED AMMO!!", "red")
                            continue
                        }

                        const boxInstanceId = boxTpl + "_SpawnPoint_Instance_Id"

                        const roundsInBoxInstanceId = thisBoxConfig.roundInBox_name + "_SpawnPoint_Instance_Id"
                        const roundsInBoxTpl = thisBoxConfig.roundInBox_id
                        const roundsInBoxCount = thisBoxConfig.round_count

                        thisSpawnPointTemplate.Items.push(
                            {
                                _id: boxInstanceId,
                                _tpl: boxTpl                                        

                            },
                            {
                                _id: roundsInBoxInstanceId,
                                _tpl: roundsInBoxTpl,                                        
                                parentId: boxInstanceId,
                                slotId: "cartridges",
                                upd: {StackObjectsCount:roundsInBoxCount}
                            }
                        )

                        thisSpawnPoint.itemDistribution.push(
                            {
                                composedKey: {
                                    key: boxInstanceId
                                },
                                relativeProbability: thisBoxWeightValue
                            }
                        )
                    }
                }
            }
        }
    }

    checkForIdTypos(lg:ILogger, dbTables:IDatabaseTables){
        const ammoBoxes = ammoBoxesJson.BOXES
        for (const cal in ammoBoxes){
            const thisCal = ammoBoxes[cal]
            
            for (const box in thisCal){

                if (cal == "GRENADES" || cal == "UGL" || cal == "FLARES"){
                    lg.log("GRENADE_UGL_FLARE: " + thisCal[box], LogTextColor.CYAN)

                    if (dbTables.templates.items[thisCal[box]]){
                        console.log("is valid")
                    } else {
                        lg.log("NOT VALID", LogTextColor.RED)
                    }
                    continue
                }

                lg.log("Ammo Box: " + box, LogTextColor.CYAN)
                if (dbTables.templates.items[box]){
                    console.log("is valid")
                } else {
                    lg.log("NOT VALID", LogTextColor.RED)
                }

                lg.log("Ammo INSIDE " + box + ": " + thisCal[box].roundInBox_id, LogTextColor.GREEN)
                if (dbTables.templates.items[thisCal[box].roundInBox_id]){
                    console.log("is valid")
                } else {
                    lg.log("NOT VALID", LogTextColor.RED)
                }
            }
        }
    }

    logAmmoAndBoxes(lg: ILogger, dbItems: Record<string, ITemplateItem>, nameContains){
        lg.log("All rounds and ammo boxes for this caliber: " + nameContains, "magenta")

        const ammosOfThisCal = []

        for (const item in dbItems){
            if (dbItems[item]._parent === "5485a8684bdc2da71d8b4567" && dbItems[item]._name.includes(nameContains)){
            
                ammosOfThisCal.push(item)
            }
        }

        for (const item in dbItems){
            if (dbItems[item]._parent === "543be5cb4bdc2deb348b4568" && dbItems[item]._name.includes(nameContains)){

                const roundInBox = dbItems[item]._props.StackSlots[0]._props.filters[0].Filter[0]
                const roundCount = dbItems[item]._props.StackSlots[0]._max_count

                lg.log(`"${item}":{
                    "roundInBox_id": "${roundInBox}",
                    "roundInBox_name": "${dbItems[roundInBox]._name}",
                    "round_count": ${roundCount},
                    "box_name": "${dbItems[item]._name}"
                },`, "green")

                for (let i = ammosOfThisCal.length-1; i >= 0; i--){
                    if (roundInBox.includes(ammosOfThisCal[i])){
                        ammosOfThisCal.splice(i, 1)
                    }
                }
                
            }
        }

        for (const ammo in ammosOfThisCal){
            lg.log(`"${dbItems[ammosOfThisCal[ammo]]._name}_BOOBS_ammobox":{
                "roundInBox_id": "${ammosOfThisCal[ammo]}",
                "roundInBox_name": "${dbItems[ammosOfThisCal[ammo]]._name}",
                "round_count": 30,
                "boxIsNew": true
            },`, "yellow")
        }

        lg.log("Rounds that have no box: " + ammosOfThisCal, "red")
    }
}

module.exports = { mod: new Mod() }